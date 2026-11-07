"""Régénère torn-stock-watch-fork.user.js à partir de la dernière version de Torn City & Foreign Stock Watch.

Usage : python maj.py
Télécharge l'original sur Greasy Fork, applique les corrections ci-dessous et écrit le fork.
Si une ligne à corriger a changé dans l'original, s'arrête sans rien écrire.
"""
import json
import re
import urllib.request
from pathlib import Path

ICI = Path(__file__).parent
# La liste des versions et le code servi se mettent à jour avec des heures d'écart : on prend le plus récent
ORIGINAL = "https://update.greasyfork.org/scripts/596452.user.js"
VERSIONS = "https://greasyfork.org/scripts/596452/versions.json"
FORK = ICI / "torn-stock-watch-fork.user.js"
RAW = "https://raw.githubusercontent.com/LittleBigDev/torn-stock-watch-fork/main/torn-stock-watch-fork.user.js"

# Heures affichées dans le fuseau du navigateur au lieu du TCT (UTC)
CORRECTIONS = [
    ("      date.getUTCFullYear() === today.getUTCFullYear() &&\n"
     "      date.getUTCMonth() === today.getUTCMonth() &&\n"
     "      date.getUTCDate() === today.getUTCDate();",
     "      date.getFullYear() === today.getFullYear() &&\n"
     "      date.getMonth() === today.getMonth() &&\n"
     "      date.getDate() === today.getDate();", 1),
    ("new Intl.DateTimeFormat('en-GB', {\n        timeZone: 'UTC',\n",
     "new Intl.DateTimeFormat('fr-FR', {\n", 1),
    ("${formatTct(item.predictedAt)} TCT", "${formatTct(item.predictedAt)}", 4),
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r:
        return r.read().decode("utf-8")


def entete(code, version):
    code = re.sub(r"^// @(downloadURL|updateURL).*\n", "", code, flags=re.M)
    for cle, val in (("name", "Torn City & Foreign Stock Watch (fork Workaround)"),
                     ("namespace", "workaround.stock-watch-fork"),
                     ("version", f"{version}-fork"),
                     ("description", f"Fork de Torn City & Foreign Stock Watch {version} : heures en heure locale.")):
        code, n = re.subn(rf"^// @{cle}( +).*$", lambda m: f"// @{cle}{m[1]}{val}", code, count=1, flags=re.M)
        if n != 1:
            raise SystemExit(f"En-tête : @{cle} introuvable")
    # Mise à jour automatique par Violentmonkey depuis le dépôt GitHub
    return re.sub(r"^(// @version .*\n)", rf"\1// @downloadURL  {RAW}\n// @updateURL    {RAW}\n", code, count=1, flags=re.M)


if __name__ == "__main__":
    def version(c):
        return re.search(r"^// @version\s+(\S+)", c, re.M)[1]
    code = max(get(json.loads(get(VERSIONS))[0]["code_url"]), get(ORIGINAL),
               key=lambda c: tuple(int(n) for n in re.findall(r"\d+", version(c))))
    version = version(code)
    erreurs = []
    for motif, remplacement, attendu in CORRECTIONS:
        trouve = code.count(motif)
        if trouve != attendu:
            erreurs.append(f"{trouve} occurrence(s) au lieu de {attendu} : {motif.splitlines()[0]}")
        code = code.replace(motif, remplacement)
    if erreurs:
        raise SystemExit("Original modifié, fork non écrit. À adapter dans maj.py :\n  " + "\n  ".join(erreurs))
    FORK.write_text(entete(code, version), encoding="utf-8", newline="\n")
    print(f"Fork écrit : Stock Watch {version}-fork. Commit et push : Violentmonkey le met à jour depuis GitHub.")
