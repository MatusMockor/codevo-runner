"""Validate a built runner image: docker-smoke.py [image] [--execution-tools].

The toolchain check runs local project commands without contacting a provider.
Execution stays disabled here; API execution has separate integration tests.
"""

import argparse
import base64
import hashlib
import json
import pathlib
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


SCREENSHOT = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAACXBIWXMAAAPoAAAD6AG1e1Jr"
    "AAAAEElEQVQImWMwqjoBRww4OQBNNhFxLVATHQAAAABJRU5ErkJggg=="
)


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(base_url, path, token=None, method="GET", data=None, extra_headers=None,
            raw=False, expected_status=200):
    headers = {"Authorization": "Bearer " + token} if token else {}
    headers.update(extra_headers or {})
    with urllib.request.urlopen(
        urllib.request.Request(base_url + path, headers=headers, method=method, data=data),
        timeout=5,
    ) as response:
        require(response.status == expected_status, "Unexpected HTTP status for " + path)
        if raw:
            require(response.headers.get_content_type() == "image/png", "Incorrect image MIME")
            return response.read()
        return json.load(response)


def store_draft(base_url, token):
    attachment_id = str(uuid.uuid4())
    uploaded = request(base_url, "/v1/attachments/" + attachment_id, token,
                       method="PUT", data=SCREENSHOT, expected_status=201,
                       extra_headers={"Content-Type": "image/png", "X-File-Name": "screen%20shot.png"})
    require(uploaded["created"] is True, "Upload was not created")
    parts = [{"type": "text", "text": "Inspect this screenshot"},
             {"type": "attachment", "attachmentId": attachment_id}]
    payload = {"idempotencyKey": str(uuid.uuid4()), "provider": "codex", "parts": parts}
    created = request(base_url, "/v1/tasks", token, method="POST",
                      data=json.dumps(payload).encode(), expected_status=201,
                      extra_headers={"Content-Type": "application/json"})
    require(created["created"] is True, "Draft was not created")
    task = created["task"]
    require(task["status"] == "draft", "Task should stay a draft")
    require(task["parts"] == parts and task["provider"] == "codex", "Draft content mismatch")
    return task, uploaded["attachment"]


def verify_draft(base_url, token, task, attachment):
    saved = request(base_url, "/v1/tasks/" + task["id"], token)
    require(saved == task, "Persisted draft changed")
    metadata = request(base_url, "/v1/attachments/" + attachment["id"], token)
    require(metadata == attachment, "Persisted attachment metadata changed")
    require(metadata["width"] == 4 and metadata["height"] == 3, "Image was not decoded correctly")
    require(metadata["bytes"] == len(SCREENSHOT), "Image size mismatch")
    require(metadata["sha256"] == hashlib.sha256(SCREENSHOT).hexdigest(), "Image checksum mismatch")
    require(metadata["name"] == "screen shot.png", "Image filename mismatch")
    content = request(base_url, "/v1/attachments/" + attachment["id"] + "/content", token, raw=True)
    require(content == SCREENSHOT, "Persisted image bytes changed")
    events = request(base_url, "/v1/tasks/" + task["id"] + "/events?after=0", token)
    require(len(events["items"]) == 1 and events["items"][0]["type"] == "task.created",
            "Draft creation event is missing or duplicated")


def wait_for_runner(base_url, token):
    deadline = time.monotonic() + 30
    while True:
        try:
            return request(base_url, "/v1/runner", token)
        except (OSError, ValueError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.2)


def verify_execution_tools(name, replacement):
    for command in (["git", "--version"], ["codex", "--version"], ["claude", "--version"],
                    ["python3", "--version"], ["make", "--version"], ["g++", "--version"]):
        require(bool(docker("exec", name, *command)), "Missing execution tool: " + command[0])
    script = """
const fs = require('node:fs');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
assert.equal(process.env.HOME, '/data/provider-home');
assert.equal(process.env.CODEX_HOME, '/data/provider-home/.codex');
for (const dir of [process.env.HOME, process.env.CODEX_HOME, '/data/projects/smoke']) {
  fs.mkdirSync(dir, {recursive: true});
}
const marker = process.env.CODEX_HOME + '/smoke-marker';
if (process.argv[1] === 'replacement') assert.equal(fs.readFileSync(marker, 'utf8'), 'persisted');
fs.writeFileSync(marker, 'persisted');
fs.writeFileSync('/tmp/codevo-smoke', 'temporary');
fs.writeFileSync('/data/projects/smoke/package.json', JSON.stringify({scripts: {test: 'node -e "process.exit(0)"'}}));
cp.execFileSync('git', ['init'], {cwd: '/data/projects/smoke', stdio: 'pipe'});
cp.execFileSync('npm', ['test'], {cwd: '/data/projects/smoke', stdio: 'pipe'});
"""
    docker("exec", name, "node", "-e", script, "replacement" if replacement else "first")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", nargs="?", default="codevo-runner:0.1.0")
    parser.add_argument("--execution-tools", action="store_true")
    arguments = parser.parse_args()
    image = arguments.image
    execution_tools = arguments.execution_tools
    name = "codevo-smoke-" + secrets.token_hex(6)
    volume = name + "-data"
    architecture = docker("image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image)

    with tempfile.TemporaryDirectory(prefix="codevo-docker-") as directory:
        token = secrets.token_urlsafe(32)
        tokenfile = pathlib.Path(directory) / "token"
        tokenfile.write_text(token)
        # Docker's nonroot user must be able to read this temporary bind mount.
        tokenfile.chmod(0o444)
        docker("volume", "create", volume)
        try:
            first_id = None
            draft = None
            for _ in range(2):
                resources = ["--pids-limit=128", "--memory=256m", "--cpus=1"]
                if execution_tools:
                    resources = ["--pids-limit=1024", "--memory=4g", "--cpus=2",
                                 "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777"]
                docker(
                    "run", "-d", "--name", name, "--read-only", "--cap-drop=ALL",
                    "--security-opt=no-new-privileges:true", *resources,
                    "--init", "-p", "127.0.0.1::4318",
                    "-v", volume + ":/data", "--mount",
                    "type=bind,src=" + str(tokenfile) + ",dst=/run/secrets/token,readonly",
                    "-e", "CODEVO_TOKEN_FILE=/run/secrets/token", image,
                )
                port = docker("port", name, "4318/tcp").rsplit(":", 1)[1]
                base_url = "http://127.0.0.1:" + port
                result = wait_for_runner(base_url, token)
                request(base_url, "/healthz")
                try:
                    request(base_url, "/v1/runner")
                    raise RuntimeError("Discovery accepted an unauthenticated request")
                except urllib.error.HTTPError as error:
                    require(error.code == 401, "Expected HTTP 401 without authentication")
                require(result["capabilities"]["taskExecution"] is False,
                        "Bootstrap runner must not advertise task execution")
                require(bool(result["runnerId"]), "Runner identity is missing")
                if first_id is not None:
                    require(result["runnerId"] == first_id,
                            "Runner identity changed after container replacement")
                if execution_tools:
                    verify_execution_tools(name, first_id is not None)
                first_id = result["runnerId"]
                if draft is None:
                    draft = store_draft(base_url, token)
                verify_draft(base_url, token, *draft)
                require(docker("exec", name, "id", "-u") != "0", "Runner runs as root")
                docker("stop", "-t", "8", name)
                require(docker("inspect", "--format", "{{.State.ExitCode}}", name) == "0",
                        "Runner did not stop cleanly")
                docker("rm", name)
            print("Docker smoke passed on " + architecture + ": authenticated discovery, "
                  "nonroot runtime, clean stop, persistent identity, draft, event and "
                  "image bytes after replacement.")
        except Exception:
            subprocess.run(["docker", "logs", name], check=False)
            raise
        finally:
            subprocess.run(["docker", "rm", "-f", name], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            docker("volume", "rm", volume)


if __name__ == "__main__":
    main()
