#!/usr/bin/env python3
"""Score sémantique via le modèle statique potion (model2vec).

STDIN  (JSON): {"refs": ["phrase douleur", ...], "items": [{"key": "...", "text": "..."}]}
STDOUT (JSON): {"<key>": <cosine 0..1>, ...}

Le modèle est chargé par id HuggingFace (cache local si présent, sinon
téléchargé à la demande). Aucune donnée ne quitte la machine hormis le
téléchargement éventuel du modèle.
"""
import sys, json, os

MODEL_ID = os.environ.get("POTION_MODEL", "Tokenade/potion-multilingual-128M-i8-tokenade")


def main() -> int:
    payload = json.load(sys.stdin)
    refs = [r for r in payload.get("refs", []) if r and r.strip()]
    items = payload.get("items", [])
    if not refs or not items:
        json.dump({}, sys.stdout)
        return 0

    import numpy as np
    from model2vec import StaticModel

    model = StaticModel.from_pretrained(MODEL_ID)

    def emb(texts):
        v = np.asarray(model.encode(texts), dtype=np.float32)
        return v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)

    centroid = emb(refs).mean(axis=0)
    centroid = centroid / (np.linalg.norm(centroid) + 1e-9)

    texts = [(it.get("text") or "")[:512] for it in items]
    sims = emb(texts) @ centroid  # cosine, refs+items normalisés

    out = {}
    for it, s in zip(items, sims):
        out[it["key"]] = round(float(max(0.0, min(1.0, s))), 4)
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
