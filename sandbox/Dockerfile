# The sandbox: where a private deployment's agents run commands against its
# file sets (docs/file-sets.md). Build context: this directory.
#
#   docker build -t minerval-sandbox:1 --build-arg SANDBOX_IMAGE=minerval-sandbox:1 sandbox/
#
# The image holds Python with the ordinary data libraries (requirements.txt)
# and the usual shell tools, and the service itself, which uses only the
# standard library. It holds no credential and needs no network at run time:
# everything is installed here, at build.
#
# What the image cannot give itself, and the deployment must (README.md,
# "What the deployment provides"): a network with no route out, the file
# sets mounted read-only, and a writable scratch directory.
FROM python:3.13-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk diffutils file tree less \
      ripgrep jq sqlite3 git \
      tar gzip bzip2 xz-utils zstd unzip zip \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /opt/minerval-sandbox/requirements.txt
RUN pip install --no-cache-dir -r /opt/minerval-sandbox/requirements.txt

COPY server.py confine.py VERSION /opt/minerval-sandbox/

# An unprivileged user. The service never needs to be root: a command is
# held to its run's sets by Landlock, which an unprivileged process applies
# to itself, and the mounts and the network are the container's.
RUN useradd --system --uid 10002 --no-create-home --shell /usr/sbin/nologin sandbox \
 && mkdir -p /sets /registered /scratch \
 && chown sandbox:sandbox /scratch

# The name a kept analysis records for the image it ran in. Pass the tag or
# the digest the deployment runs; it is also settable when the container
# starts.
ARG SANDBOX_IMAGE="not stated"
ENV SANDBOX_IMAGE=${SANDBOX_IMAGE} \
    SANDBOX_STORE_DIR=/sets \
    SANDBOX_DIRECTORY_ROOT=/registered \
    SANDBOX_SCRATCH_DIR=/scratch \
    SANDBOX_PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER sandbox
WORKDIR /scratch
EXPOSE 8080
VOLUME ["/scratch"]
# The token is in the environment the container was started with.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python3 -c "import os,urllib.request as u; u.urlopen(u.Request('http://127.0.0.1:8080/health', headers={'Authorization': 'Bearer ' + os.environ['SANDBOX_TOKEN']}), timeout=4)" || exit 1
CMD ["python3", "/opt/minerval-sandbox/server.py"]
