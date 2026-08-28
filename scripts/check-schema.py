#!/usr/bin/env python3
"""Check every document under data/ against data/schema.json.

    python3 scripts/check-schema.py                    # every default file
    python3 scripts/check-schema.py /tmp/releve.json   # plus anything you name

Stdlib only, like the rest of the scripts here, so this is a validator for the
subset of JSON Schema that `data/schema.json` actually uses rather than a general
one. That subset is listed in KEYWORDS, and **an unrecognised keyword in the
schema is an error**, not something skipped: a validator that silently ignores
half a constraint reports every file as fine, which is worse than no validator.

Documents are dispatched on their own `schema` string through the `documents` map
at the root of data/schema.json.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCHEMA_PATH = os.path.join(ROOT, "data", "schema.json")

DEFAULT_TARGETS = [
    "data/demo.json",
    "data/local.json",      # only after `make mine`; absent is not a failure
    "data/rates.json",
    "data/testcases.json",
    "data/tokenizer.json",
]

# Constraints this validator understands and enforces.
KEYWORDS = {
    "$ref", "type", "const", "enum", "required", "properties",
    "additionalProperties", "items", "prefixItems", "minItems", "maxItems",
}
# Constraints that carry no assertion, so ignoring them loses nothing.
ANNOTATIONS = {"description", "title", "$comment", "examples", "default", "deprecated"}

TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "null": type(None),
}


def type_ok(value, name):
    """`bool` is a subclass of `int` in Python and is not a number in JSON."""
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "boolean":
        return isinstance(value, bool)
    return isinstance(value, TYPES[name])


def resolve(schema, root):
    """Follow `$ref` chains. Only local JSON pointers are supported."""
    seen = 0
    while "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise ValueError(f"only local refs are supported, got {ref!r}")
        node = root
        for part in ref[2:].split("/"):
            node = node[part]
        schema = node
        seen += 1
        if seen > 20:
            raise ValueError(f"ref cycle at {ref!r}")
    return schema


def audit_keywords(schema, root, where, problems, seen):
    """Every keyword in the schema itself must be one we enforce."""
    if id(schema) in seen:
        return
    seen.add(id(schema))
    for key, value in schema.items():
        if key in ANNOTATIONS or key in ("$schema", "$id", "$defs", "documents"):
            continue
        if key not in KEYWORDS:
            problems.append(f"{where}: schema uses unsupported keyword {key!r}")
            continue
        if key in ("properties", "patternProperties"):
            for name, sub in value.items():
                audit_keywords(sub, root, f"{where}.{key}.{name}", problems, seen)
        elif key in ("items", "additionalProperties") and isinstance(value, dict):
            audit_keywords(value, root, f"{where}.{key}", problems, seen)
        elif key == "prefixItems":
            for i, sub in enumerate(value):
                audit_keywords(sub, root, f"{where}[{i}]", problems, seen)
    for name, sub in (schema.get("$defs") or {}).items():
        audit_keywords(sub, root, f"$defs.{name}", problems, seen)


def validate(value, schema, root, path, errors):
    schema = resolve(schema, root)

    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected {schema['const']!r}, got {value!r}")
        return
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} is not one of {schema['enum']}")
        return
    if "type" in schema:
        names = schema["type"]
        names = [names] if isinstance(names, str) else names
        if not any(type_ok(value, n) for n in names):
            errors.append(f"{path}: expected {'|'.join(names)}, got {kind(value)}")
            return

    if isinstance(value, dict):
        props = schema.get("properties") or {}
        for name in schema.get("required") or []:
            if name not in value:
                errors.append(f"{path}.{name}: required, missing")
        extra = schema.get("additionalProperties", True)
        for name, item in value.items():
            if name in props:
                validate(item, props[name], root, f"{path}.{name}", errors)
            elif extra is False:
                errors.append(f"{path}.{name}: not in the contract")
            elif isinstance(extra, dict):
                validate(item, extra, root, f"{path}.{name}", errors)

    elif isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: {len(value)} items, at least {schema['minItems']} required")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: {len(value)} items, at most {schema['maxItems']} allowed")
        prefix = schema.get("prefixItems") or []
        for i, item in enumerate(value):
            if i < len(prefix):
                validate(item, prefix[i], root, f"{path}[{i}]", errors)
            elif "items" in schema:
                validate(item, schema["items"], root, f"{path}[{i}]", errors)


def kind(value):
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    return {dict: "object", list: "array", str: "string", type(None): "null"}[type(value)]


def check(path, root):
    rel = os.path.relpath(path, ROOT)
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except ValueError as exc:
        return [f"{rel}: not valid JSON: {exc}"]

    name = doc.get("schema") if isinstance(doc, dict) else None
    ref = (root.get("documents") or {}).get(name)
    if not ref:
        return [f"{rel}: carries schema {name!r}, which data/schema.json does not document"]

    errors = []
    validate(doc, {"$ref": ref}, root, rel, errors)
    return errors


def main():
    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        root = json.load(fh)

    problems = []
    audit_keywords(root, root, "data/schema.json", problems, set())
    if problems:
        for line in problems:
            print(f"  {line}")
        print(f"\ndata/schema.json is not fully enforceable: {len(problems)} problem(s).")
        return 1

    targets = [os.path.join(ROOT, t) for t in DEFAULT_TARGETS]
    targets += [os.path.abspath(a) for a in sys.argv[1:]]

    failed = checked = 0
    for path in targets:
        rel = os.path.relpath(path, ROOT)
        if not os.path.exists(path):
            if os.path.join(ROOT, "data", "local.json") == path:
                print(f"  skip  {rel} (absent until `make mine`)")
                continue
            print(f"  FAIL  {rel}: no such file")
            failed += 1
            continue
        errors = check(path, root)
        checked += 1
        if errors:
            failed += 1
            print(f"  FAIL  {rel}")
            for line in errors[:20]:
                print(f"          {line}")
            if len(errors) > 20:
                print(f"          ... and {len(errors) - 20} more")
        else:
            print(f"  ok    {rel}")

    print()
    if failed:
        print(f"{failed} of {checked} document(s) do not match data/schema.json.")
        return 1
    print(f"{checked} document(s) match data/schema.json.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
