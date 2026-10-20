#!/bin/bash
# Construye la aplicación a partir de los archivos originales.
set -e
cd "$(dirname "$0")"

{
cat <<'HEAD'
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<meta name="description" content="Sashidy Planner: agenda personal para organizar actividades, tareas y compromisos.">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f2f2f7">
<meta name="format-detection" content="telephone=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Sashidy Planner">
<link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" sizes="180x180" href="icons/icon-180.png">
<link rel="icon" href="icons/icon-192.png">
<title>Sashidy Planner</title>
<style>
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:#f2f2f7;color-scheme:light dark;font:14px system-ui}
  img{max-width:100%}
  [hidden]{display:none!important}
</style>
</head>
<body>
HEAD

echo '<script>'
cat src/i18n.js
echo '</script>'
grep -v '^<title>Planly</title>$' src/app.html

cat <<'TAIL'
<script>
if('serviceWorker' in navigator && location.protocol.indexOf('http')===0){
  window.addEventListener('load',function(){
    navigator.serviceWorker.register('sw.js').catch(function(){});
  });
}
</script>
</body>
</html>
TAIL
} > index.html

# Fecha de construcción que aparece en los ajustes.
BUILD_STAMP=$(date '+%d.%m %H:%M')
python3 - "$BUILD_STAMP" <<'PYEOF'
import sys
p='index.html'; s=open(p).read()
open(p,'w').write(s.replace('__BUILD__', sys.argv[1]))
PYEOF

echo "index.html generado: $(wc -c < index.html) bytes"

# Prepara los archivos que publicará Vercel.
VER=$(date +%Y%m%d%H%M%S)
rm -rf dist && mkdir -p dist
cp index.html manifest.json dist/

# Conserva la variante independiente fuera de la publicación.
mkdir -p .build
{ echo '<script>'; cat src/i18n.js; echo '</script>'; cat src/app.html; } > .build/artifact.html

printf '%s' "$BUILD_STAMP" > dist/version.txt
sed "s/planly-v1/planly-$VER/" sw.js > dist/sw.js
cp -R icons dist/icons

echo "Publicación preparada: $BUILD_STAMP"
