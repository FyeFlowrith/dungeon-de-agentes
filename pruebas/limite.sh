#!/bin/zsh
# Pasa cada transcripción de limite/ por la extensión (vscode/sesiones.js) y por la app de macOS
# (--analizar) y compara: el prefijo del archivo dice lo esperado (sin-cuota-- o libre--), y las dos
# partes tienen que deducir lo mismo.
# Uso: ./limite.sh [binario de la app]   (por defecto el de mac/build/; armalo antes con mac/armar.sh)
SRC=${0:A:h}
APP=${1:-$SRC/../mac/build/Dungeon de agentes.app/Contents/MacOS/dungeon-de-agentes}
fallas=0

for f in $SRC/limite/*.jsonl; do
  nombre=${f:t:r}
  [[ $nombre == sin-cuota--* ]] && esperado=true || esperado=false
  ext=$(node -e '
    const { analizar } = require(process.argv[1]);
    const i = analizar(process.argv[2], require("fs").statSync(process.argv[2]).size, null);
    console.log(JSON.stringify({ limitado: i.limitado, ultimo: i.ultimo }));
  ' "$SRC/../vscode/sesiones.js" "$f")
  mac=$("$APP" --analizar "$f")
  if [[ $ext != *"\"limitado\":$esperado"* ]]; then
    echo "FALLA  $nombre: la extensión dio $ext"; ((fallas++))
  elif [[ $ext != $mac ]]; then
    echo "FALLA  $nombre: la extensión dio $ext y la app $mac"; ((fallas++))
  else
    echo "ok     $nombre"
  fi
done

(( fallas )) && { echo "$fallas fallas"; exit 1 }
echo "todo ok"
