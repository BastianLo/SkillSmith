"""Static checks for toolsmith scripts (runs on the user's Python, 3.8+).

Usage: python3 checker.py --target 3.9 --module NAME CODE_FILE TEST_FILE
Prints one JSON object:
  errors, warnings, imports {stdlib, third_party, missing}, capabilities,
  tests (number of test methods), has_main_guard, uses_argparse, python
"""
import argparse
import ast
import importlib.util
import json
import os
import sys
import sysconfig

NETWORK_MODULES = {
    "socket", "ssl", "http", "urllib", "urllib3", "requests", "httpx", "aiohttp", "ftplib", "smtplib",
    "poplib", "imaplib", "telnetlib", "xmlrpc", "paramiko", "websocket", "websockets", "pycurl", "boto3",
    "botocore", "socketserver", "asyncssh", "grpc",
}
NETWORK_SUBMODULE_EXEMPT = {"urllib.parse", "http.HTTPStatus", "http.cookies"}
SUBPROCESS_MODULES = {"subprocess", "pty", "pexpect", "sh", "plumbum"}
SUBPROCESS_CALLS = {
    "os.system", "os.popen", "os.execv", "os.execve", "os.execvp", "os.execvpe", "os.execl", "os.execle",
    "os.execlp", "os.execlpe", "os.spawnv", "os.spawnve", "os.spawnvp", "os.spawnl", "os.spawnlp", "os.fork",
    "os.posix_spawn", "os.posix_spawnp", "asyncio.create_subprocess_exec", "asyncio.create_subprocess_shell",
}
DELETE_CALLS = {"os.remove", "os.unlink", "os.rmdir", "os.removedirs", "shutil.rmtree"}
DELETE_METHODS = {"unlink", "rmdir", "rmtree"}
WRITE_CALLS = {
    "os.makedirs", "os.mkdir", "os.rename", "os.renames", "os.replace", "os.chmod", "os.chown", "os.symlink",
    "os.link", "os.truncate", "shutil.copy", "shutil.copy2", "shutil.copyfile", "shutil.copytree", "shutil.move",
    "shutil.make_archive", "os.utime",
}
WRITE_METHODS = {"write_text", "write_bytes", "mkdir", "touch", "rename", "replace", "symlink_to", "hardlink_to", "chmod"}
ENV_CALLS = {"os.getenv", "os.putenv", "os.unsetenv"}

# names that are newer than the target version: (module, name) -> version
NEWER_NAMES = {
    ("typing", "TypeAlias"): (3, 10), ("typing", "ParamSpec"): (3, 10), ("typing", "Concatenate"): (3, 10),
    ("typing", "TypeGuard"): (3, 10), ("typing", "Self"): (3, 11), ("typing", "LiteralString"): (3, 11),
    ("typing", "Never"): (3, 11), ("typing", "Required"): (3, 11), ("typing", "NotRequired"): (3, 11),
    ("typing", "assert_never"): (3, 11), ("typing", "reveal_type"): (3, 11), ("typing", "override"): (3, 12),
    ("itertools", "pairwise"): (3, 10), ("itertools", "batched"): (3, 12), ("datetime", "UTC"): (3, 11),
    ("contextlib", "aclosing"): (3, 10), ("contextlib", "chdir"): (3, 11), ("enum", "StrEnum"): (3, 11),
}
NEWER_MODULES = {"tomllib": (3, 11), "graphlib": (3, 9), "zoneinfo": (3, 9), "wsgiref.types": (3, 11)}


def dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def parse_target(text):
    major, minor = text.split(".")[:2]
    return int(major), int(minor)


class Analyzer(ast.NodeVisitor):
    def __init__(self, target, future_annotations):
        self.target = target
        self.future_annotations = future_annotations
        self.imports = set()
        self.from_imports = []
        self.caps = set()
        self.errors = []
        self.warnings = []
        self.aliases = {}
        self.uses_argparse = False

    def visit_Import(self, node):
        for a in node.names:
            top = a.name.split(".")[0]
            self.imports.add(top)
            self.aliases[a.asname or top] = a.name if a.asname else top
            self.check_module(a.name, node)
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.level and node.level > 0:
            return
        mod = node.module or ""
        top = mod.split(".")[0]
        if mod == "__future__":
            return
        self.imports.add(top)
        self.check_module(mod, node)
        for a in node.names:
            self.aliases[a.asname or a.name] = "%s.%s" % (mod, a.name)
            need = NEWER_NAMES.get((mod, a.name))
            if need and need > self.target:
                self.errors.append(
                    "line %d: %s.%s needs Python %d.%d (target %d.%d)" % (node.lineno, mod, a.name, need[0], need[1], self.target[0], self.target[1])
                )
            full = "%s.%s" % (mod, a.name)
            if mod in SUBPROCESS_MODULES or top in SUBPROCESS_MODULES:
                self.caps.add("subprocess")
            if full in SUBPROCESS_CALLS:
                self.caps.add("subprocess")
            if full in DELETE_CALLS:
                self.caps.add("delete")
            if full in WRITE_CALLS:
                self.caps.add("filesystem-write")
            if full == "os.environ" or full in ENV_CALLS:
                self.caps.add("env")
        self.generic_visit(node)

    def check_module(self, name, node):
        top = name.split(".")[0]
        if top == "argparse":
            self.uses_argparse = True
        need = NEWER_MODULES.get(name) or NEWER_MODULES.get(top)
        if need and need > self.target:
            self.errors.append("line %d: module %s needs Python %d.%d" % (node.lineno, name, need[0], need[1]))
        if top in SUBPROCESS_MODULES:
            self.caps.add("subprocess")
        if top in NETWORK_MODULES and name not in NETWORK_SUBMODULE_EXEMPT:
            if top in ("urllib", "http"):
                if name in ("urllib.request", "http.client", "http.server") or name in ("urllib", "http"):
                    self.caps.add("network")
            else:
                self.caps.add("network")

    def resolve(self, name):
        if not name:
            return None
        head = name.split(".")[0]
        if head in self.aliases:
            return self.aliases[head] + name[len(head):]
        return name

    def visit_Call(self, node):
        name = self.resolve(dotted(node.func))
        if name:
            if name in SUBPROCESS_CALLS:
                self.caps.add("subprocess")
            if name in DELETE_CALLS:
                self.caps.add("delete")
            if name in WRITE_CALLS:
                self.caps.add("filesystem-write")
            if name in ENV_CALLS:
                self.caps.add("env")
            if name.startswith("urllib.request.") or name.startswith("http.client.") or name.startswith("socket."):
                self.caps.add("network")
            if name in ("open", "io.open", "codecs.open") or name.endswith(".open"):
                mode = None
                if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
                    mode = node.args[1].value
                for kw in node.keywords:
                    if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                        mode = kw.value.value
                if isinstance(mode, str) and any(c in mode for c in "wax+"):
                    self.caps.add("filesystem-write")
        if isinstance(node.func, ast.Attribute):
            if node.func.attr in DELETE_METHODS:
                self.caps.add("delete")
            elif node.func.attr in WRITE_METHODS:
                self.caps.add("filesystem-write")
        self.generic_visit(node)

    def visit_Attribute(self, node):
        name = self.resolve(dotted(node))
        if name and (name == "os.environ" or name.startswith("os.environ.")):
            self.caps.add("env")
        self.generic_visit(node)

    def visit_Name(self, node):
        if self.aliases.get(node.id) == "os.environ":
            self.caps.add("env")

    def check_annotation(self, ann, where):
        if ann is None or self.future_annotations or self.target >= (3, 10):
            return
        for sub in ast.walk(ann):
            if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.BitOr):
                self.errors.append(
                    "line %d: 'X | Y' in %s needs Python 3.10 – add 'from __future__ import annotations' or use Optional/Union"
                    % (getattr(ann, "lineno", 0), where)
                )
                return

    def visit_FunctionDef(self, node):
        for a in node.args.args + node.args.kwonlyargs + getattr(node.args, "posonlyargs", []):
            self.check_annotation(a.annotation, "an annotation")
        if node.args.vararg:
            self.check_annotation(node.args.vararg.annotation, "an annotation")
        if node.args.kwarg:
            self.check_annotation(node.args.kwarg.annotation, "an annotation")
        self.check_annotation(node.returns, "a return annotation")
        self.generic_visit(node)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_AnnAssign(self, node):
        # module/class level annotations are evaluated at runtime
        self.check_annotation(node.annotation, "a variable annotation")
        self.generic_visit(node)

    def visit_Match(self, node):  # Python 3.10+ AST only
        if self.target < (3, 10):
            self.errors.append("line %d: match statements need Python 3.10" % node.lineno)
        self.generic_visit(node)


def stdlib_paths():
    paths = set()
    for key in ("stdlib", "platstdlib"):
        p = sysconfig.get_paths().get(key)
        if p:
            paths.add(os.path.realpath(p))
    return paths


def classify(names, local):
    std, third, missing = [], [], []
    roots = stdlib_paths()
    builtin = set(sys.builtin_module_names)
    stdnames = set(getattr(sys, "stdlib_module_names", ()))
    for name in sorted(names):
        if name in local or name == "__future__":
            continue
        if name in builtin or name in stdnames:
            std.append(name)
            continue
        try:
            spec = importlib.util.find_spec(name)
        except Exception:
            spec = None
        if spec is None:
            missing.append(name)
            continue
        origin = spec.origin or ""
        if origin in ("built-in", "frozen"):
            std.append(name)
            continue
        locs = list(spec.submodule_search_locations or []) or [origin]
        real = [os.path.realpath(x) for x in locs if x]
        if real and all(any(r.startswith(root) for root in roots) and "site-packages" not in r and "dist-packages" not in r for r in real):
            std.append(name)
        else:
            third.append(name)
    return std, third, missing


def count_tests(tree):
    n = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name.startswith("test"):
                    n += 1
    return n


def has_main_guard(tree):
    for node in tree.body:
        if isinstance(node, ast.If):
            src = ast.dump(node.test)
            if "__name__" in src and "__main__" in src:
                return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default="3.9")
    ap.add_argument("--module", required=True)
    ap.add_argument("code")
    ap.add_argument("test")
    args = ap.parse_args()
    target = parse_target(args.target)
    out = {
        "errors": [],
        "warnings": [],
        "imports": {"stdlib": [], "third_party": [], "missing": []},
        "capabilities": [],
        "tests": 0,
        "has_main_guard": False,
        "uses_argparse": False,
        "python": "%d.%d.%d" % sys.version_info[:3],
    }
    trees = {}
    for label, path in (("code", args.code), ("test", args.test)):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                src = fh.read()
        except OSError as exc:
            out["errors"].append("%s: cannot read %s (%s)" % (label, os.path.basename(path), exc))
            continue
        try:
            kwargs = {}
            if sys.version_info >= (3, 8):
                kwargs["feature_version"] = target
            tree = ast.parse(src, filename=os.path.basename(path), **kwargs)
        except SyntaxError as exc:
            out["errors"].append(
                "%s: syntax error (Python %s) line %s: %s" % (os.path.basename(path), args.target, exc.lineno, exc.msg)
            )
            continue
        trees[label] = (tree, src)
    imports = set()
    for label, (tree, src) in trees.items():
        future = any(
            isinstance(n, ast.ImportFrom) and n.module == "__future__" and any(a.name == "annotations" for a in n.names)
            for n in tree.body
        )
        an = Analyzer(target, future)
        an.visit(tree)
        out["errors"].extend("%s: %s" % (os.path.basename(args.code if label == "code" else args.test), e) for e in an.errors)
        imports |= an.imports
        if label == "code":
            out["capabilities"] = sorted(an.caps)
            out["has_main_guard"] = has_main_guard(tree)
            out["uses_argparse"] = an.uses_argparse
            if not ast.get_docstring(tree):
                out["warnings"].append("the script has no module docstring")
        else:
            out["tests"] = count_tests(tree)
            if args.module not in an.imports:
                out["warnings"].append("the test file does not import %s" % args.module)
    std, third, missing = classify(imports, {args.module, "test_" + args.module})
    out["imports"] = {"stdlib": std, "third_party": third, "missing": missing}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
