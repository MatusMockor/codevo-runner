"""Validate an already built runner image: python3 scripts/docker-smoke.py [image]."""

import json
import pathlib
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(base_url, path, token=None):
    headers = {"Authorization": "Bearer " + token} if token else {}
    with urllib.request.urlopen(
        urllib.request.Request(base_url + path, headers=headers), timeout=2
    ) as response:
        return json.load(response)


def wait_for_runner(base_url, token):
    deadline = time.monotonic() + 30
    while True:
        try:
            return request(base_url, "/v1/runner", token)
        except (OSError, ValueError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.2)


def main():
    image = sys.argv[1] if len(sys.argv) > 1 else "codevo-runner:0.1.0"
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
            for _ in range(2):
                docker(
                    "run", "-d", "--name", name, "--read-only", "--cap-drop=ALL",
                    "--security-opt=no-new-privileges:true", "--pids-limit=128",
                    "--memory=256m", "--cpus=1", "--init", "-p", "127.0.0.1::4318",
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
                first_id = result["runnerId"]
                require(docker("exec", name, "id", "-u") != "0", "Runner runs as root")
                docker("stop", "-t", "8", name)
                require(docker("inspect", "--format", "{{.State.ExitCode}}", name) == "0",
                        "Runner did not stop cleanly")
                docker("rm", name)
            print("Docker smoke passed on " + architecture + ": authenticated discovery, "
                  "nonroot runtime, clean stop, persistent identity after replacement.")
        except Exception:
            subprocess.run(["docker", "logs", name], check=False)
            raise
        finally:
            subprocess.run(["docker", "rm", "-f", name], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            docker("volume", "rm", volume)


if __name__ == "__main__":
    main()
