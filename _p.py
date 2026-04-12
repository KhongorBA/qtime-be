from pathlib import Path

def patch_file(path, old, new):
    p = Path(path)
    t = p.read_text(encoding="utf-8")
    if old not in t:
        raise SystemExit(f"not found in {path}")
    p.write_text(t.replace(old, new, 1), encoding="utf-8", newline="\n")

patch_file("src/routes/booking.py", "", "")  # typo guard
