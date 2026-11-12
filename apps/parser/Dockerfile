# Build context: repository root.
# Wolfi (Chainguard, Apache-2.0) packages get CVE fixes within days; Debian's python3.13/krb5
# carried unfixed HIGHs (Prisma would kill the pod). Python 3.13: onnxruntime (markitdown ->
# magika) has no 3.15 wheel yet, and Chainguard's free python image is 3.15 only.
# The final image is FROM scratch: python + libs + site-packages, no shell, no apk.
FROM cgr.dev/chainguard/wolfi-base AS build
RUN apk add --no-cache python-3.13 py3.13-pip
COPY apps/parser/requirements.txt /tmp/requirements.txt
RUN python3.13 -m venv /venv \
 && /venv/bin/pip install --no-cache-dir --only-binary=:all: -r /tmp/requirements.txt \
 && mkdir -p /app /tmp-empty \
 && cp -r /venv/lib/python3.13/site-packages /app/site-packages && rm -rf /app/site-packages/pip /app/site-packages/pip-* \
 && apk del --no-cache py3.13-pip py3.13-pip-base py3.13-setuptools py3-pip-wheel
COPY apps/parser/server.py /app/server.py
# Strip everything executable that is not python (shell, busybox applets, apk) and the system
# site-packages; pip/setuptools are build tools only. Python does it, since rm/find are busybox
# applets themselves.
RUN ["/usr/bin/python3.13", "-c", "import os,shutil\nimport glob\nfor p in ['/venv','/root/.cache','/etc/apk/keys']+glob.glob('/usr/lib/python3.13/site-packages/*'): shutil.rmtree(p, ignore_errors=True)\nfor d in ['/bin','/sbin','/usr/bin','/usr/sbin']:\n  for n in os.listdir(d):\n    f=os.path.join(d,n)\n    if (os.path.islink(f) and 'busybox' in os.readlink(f)) or n in ('busybox','sh','apk') or n.startswith('pip'): os.remove(f)"]

FROM scratch
COPY --from=build / /
COPY --from=build --chown=65532:65532 /tmp-empty /tmp
WORKDIR /app
ENV PYTHONPATH=/app/site-packages \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp \
    PATH=/usr/bin
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/bin/python3.13", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
