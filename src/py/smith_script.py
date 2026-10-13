"""Helper of the call_script contract (skillsmith 5e).

Parameters arrive as JSON on stdin, the result leaves as JSON on stdout in the envelope
{"ok": true, "data": ...} or {"ok": false, "error": "..."}; log output goes to stderr.
The script only writes main(params):

    from smith_script import run

    def main(params):
        return {"sum": params["a"] + params["b"]}

    if __name__ == "__main__":
        run(main)

skillsmith copies this file next to the script when it runs or tests it.
"""
import json
import sys


def log(*args):
    print(*args, file=sys.stderr)


def run(main, argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if "--help" in argv or "-h" in argv:
        doc = (sys.modules["__main__"].__doc__ or "").strip()
        print("usage: echo '{...json params...}' | python3 " + sys.argv[0] + "\n" + doc)
        return 0
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        params = json.loads(raw) if raw.strip() else {}
        data = main(params)
        sys.stdout.write(json.dumps({"ok": True, "data": data}, ensure_ascii=False, default=str) + "\n")
        return 0
    except Exception as err:  # noqa: BLE001 - every error goes into the envelope
        sys.stdout.write(json.dumps({"ok": False, "error": "%s: %s" % (type(err).__name__, err)}, ensure_ascii=False) + "\n")
        return 1
