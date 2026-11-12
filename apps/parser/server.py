"""Document -> markdown service (markitdown). Stand-in for the company's intelligent parser
(markitdown + Cohere + Azure Document Intelligence): same contract, POST /convert with a
multipart `file`, returns text/markdown. Runs in-process only: no subprocess, no network."""

import io
import os

from markitdown import MarkItDown, StreamInfo
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route

MAX_BYTES = int(os.environ.get("MAX_BYTES", str(100 * 1024 * 1024)))
# Plugins off; no LLM or Document Intelligence clients: local converters only.
md = MarkItDown(enable_plugins=False)


async def convert(request: Request) -> PlainTextResponse:
    form = await request.form(max_part_size=MAX_BYTES)
    upload = form.get("file")
    if upload is None or isinstance(upload, str):
        return PlainTextResponse("multipart field 'file' is required", status_code=400)
    data = await upload.read()
    name = upload.filename or "document"
    ext = os.path.splitext(name)[1].lower() or None
    try:
        result = md.convert_stream(io.BytesIO(data), stream_info=StreamInfo(filename=name, extension=ext))
    except Exception as e:  # unsupported or broken file: report, do not crash the worker
        return PlainTextResponse(f"cannot convert {name}: {type(e).__name__}: {e}", status_code=422)
    return PlainTextResponse(result.markdown, media_type="text/markdown; charset=utf-8")


async def healthz(_: Request) -> PlainTextResponse:
    return PlainTextResponse("ok")


app = Starlette(routes=[Route("/convert", convert, methods=["POST"]), Route("/healthz", healthz)])
