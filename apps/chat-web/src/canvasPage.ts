// Builds the document a canvas runs in (H52): the model's fragment + theme CSS + Apache ECharts
// (Apache-2.0, bundled: no CDN) + a small runtime (state, charts, send-to-chat). It runs as srcdoc
// in <iframe sandbox="allow-scripts">: opaque origin (no cookies, no access to the portal), and a
// CSP that blocks every network request. The same document is what "Baixar" saves.

let echartsSrc: Promise<string> | undefined;
const loadECharts = () => (echartsSrc ??= import("echarts/dist/echarts.min.js?raw").then((m) => m.default));

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

const LIGHT = { bg: "#ffffff", surface: "#f6f6f4", fg: "#141413", fg2: "#4a4a47", fg3: "#6b6b67", line: "#e4e4e1", accent: "#1d5fd1", good: "#187a3d", bad: "#b42318" };
const DARK = { bg: "#1d1d1c", surface: "#262625", fg: "#ececea", fg2: "#c3c3bf", fg3: "#9a9a95", line: "#363634", accent: "#7aa7f5", good: "#5cc58a", bad: "#f27b70" };
const PALETTE = { light: ["#1d5fd1", "#e07a1f", "#2f9e6e", "#c2417d", "#7b5cd6", "#8a8a84"], dark: ["#7aa7f5", "#f0a35e", "#5cc58a", "#e57aa8", "#a48cf0", "#a3a39e"] };

function css(theme: "light" | "dark") {
	const t = theme === "dark" ? DARK : LIGHT;
	return `:root{--bg:${t.bg};--surface:${t.surface};--fg:${t.fg};--fg-2:${t.fg2};--fg-3:${t.fg3};--line:${t.line};--accent:${t.accent};--good:${t.good};--bad:${t.bad};--radius:10px;color-scheme:${theme}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
body{padding:20px 24px 32px;max-width:960px;margin:0 auto}
h1{font-size:22px;line-height:1.25;margin:0 0 12px}h2{font-size:17px;margin:20px 0 8px}h3{font-size:15px;margin:16px 0 6px}
p{margin:0 0 10px}.muted{color:var(--fg-3);font-size:13px}
.big{font-size:34px;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums;line-height:1.15}
.card{border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;margin:0 0 14px;background:var(--bg)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:0 0 14px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
label{display:grid;gap:4px;font-size:13px;color:var(--fg-2)}
input,select,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;min-height:36px}
input[type=checkbox],input[type=radio]{min-height:0;width:16px;height:16px;accent-color:var(--accent)}
input[type=range]{accent-color:var(--accent);padding:0}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button{font:inherit;font-weight:500;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:6px 14px;cursor:pointer}
button:hover{background:var(--surface)}button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}th{color:var(--fg-2);font-weight:600}
ul,ol{padding-left:22px}a{color:var(--accent)}`;
}

/** Runtime exposed as window.canvas. Messages to the portal carry a per-frame token. */
function runtime(token: string, theme: "light" | "dark", state: unknown) {
	return `(()=>{const T=${JSON.stringify(token)};const post=(m)=>{try{parent.postMessage({...m,token:T},"*")}catch(e){}};let timer;
const colors=${JSON.stringify(PALETTE[theme])};const charts=new Set();
const c={theme:${JSON.stringify(theme)},colors,state:${JSON.stringify(state ?? {})},
save(s){if(s!==undefined)c.state=s;clearTimeout(timer);timer=setTimeout(()=>post({type:"canvas:state",state:c.state}),400)},
send(text){post({type:"canvas:send",text:String(text).slice(0,4000)})},
chart(el,option){if(!window.echarts)throw new Error("echarts not loaded");const ch=echarts.init(el,"canvas",{renderer:"svg"});
if(option&&Object.keys(option).length)ch.setOption(option);charts.add(ch);return ch}};
// Theme registered once, so it survives setOption(..., true) and pages that call echarts.init themselves.
if(window.echarts){const cs=getComputedStyle(document.documentElement),v=(n)=>cs.getPropertyValue(n).trim();const fg=v("--fg-3"),ln=v("--line"),bg=v("--bg"),tx=v("--fg");
const axis={axisLine:{lineStyle:{color:ln}},axisTick:{lineStyle:{color:ln}},axisLabel:{color:fg},splitLine:{lineStyle:{color:ln}},splitArea:{show:false}};
echarts.registerTheme("canvas",{color:colors,backgroundColor:"transparent",textStyle:{color:fg,fontFamily:"inherit"},title:{textStyle:{color:tx},subtextStyle:{color:fg}},
legend:{textStyle:{color:fg}},tooltip:{backgroundColor:bg,borderColor:ln,textStyle:{color:tx}},grid:{left:8,right:8,top:28,bottom:8,containLabel:true},
categoryAxis:axis,valueAxis:axis,timeAxis:axis,logAxis:axis});
const init=echarts.init.bind(echarts);echarts.init=(el,theme,opts)=>init(el,theme||"canvas",opts);}
window.canvas=c;addEventListener("resize",()=>charts.forEach((x)=>x.resize()));
addEventListener("error",(e)=>post({type:"canvas:error",message:String(e.message||e).slice(0,300)}));})();`;
}

const esc = (s: string) => s.replace(/<\/script/gi, "<\\/script");

export async function buildCanvasPage(fragment: string, opts: { theme: "light" | "dark"; state: unknown; token: string; title: string }): Promise<string> {
	const echarts = await loadECharts();
	return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${opts.title.replace(/[<&"]/g, "")}</title>
<style>${css(opts.theme)}</style><script>${esc(echarts)}</script><script>${esc(runtime(opts.token, opts.theme, opts.state))}</script></head>
<body>${fragment}</body></html>`;
}
