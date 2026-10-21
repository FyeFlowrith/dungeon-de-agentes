# Dungeon de agentes (app de macOS)

App nativa (Swift + WebKit, sin Chrome ni Node) para quien usa Claude Code en la Terminal.

- Ventana propia con las tarjetas, buscador arriba (Cmd+F, Esc borra) y tarjetas de 220 px como mínimo que se
  acomodan por fila al agrandar la ventana y se estiran para llenar el ancho.
- Las mismas tarjetas que la extensión: héroe, slime, franja de contexto, pila de monedas con el gasto
  («≈ u$s», a precio de lista) y la ayuda al pasar el mouse. Qué es cada cosa y de dónde sale: en el
  [README principal](../README.md).
- Ícono en el Dock (con numerito de agentes que te necesitan) y en la barra de menú.
- **Siempre visible** (📌 junto al buscador, ⇧⌘T o el menú): queda por encima de todas las ventanas.
- Cerrar la ventana la esconde; clic en el Dock la vuelve a mostrar. Cmd+Q la cierra.
- Clic en una tarjeta: si el agente corre en Terminal o iTerm2, va a su pestaña; si corre en VS Code,
  abre VS Code en la ventana y la pestaña de esa conversación (con la extensión de `../vscode` instalada;
  sin ella, usa el link de la extensión de Claude).

## Armar e instalar

Requiere las Command Line Tools de Xcode (`xcode-select --install`).

```bash
./armar.sh                       # deja build/Dungeon de agentes.app (universal, macOS 12+)
ditto "build/Dungeon de agentes.app" "/Applications/Dungeon de agentes.app"
```

## Permisos

- **Automatización** (controlar Terminal/iTerm2): macOS lo pide la primera vez.
- **Accesibilidad**: para cambiar de pestaña en la Terminal (sus pestañas son del sistema y solo se
  pueden elegir desde el menú Ventana). La firma es local (ad hoc) y cambia en cada armado, así que
  después de reinstalar el permiso queda colgado (aparece prendido pero no vale). Reinicialo y volvé a
  darlo:

  ```bash
  tccutil reset Accessibility local.dungeon-de-agentes
  ```

## Si algo falla

- Registro de cada clic: `~/Library/Logs/DungeonDeAgentes.log`.
- Qué agentes detecta, sin abrir la ventana:
  `"/Applications/Dungeon de agentes.app/Contents/MacOS/dungeon-de-agentes" --json`
- Cómo ve la Terminal las ventanas y pestañas (lo escribe en el registro):
  `open -n "/Applications/Dungeon de agentes.app" --args --diag-terminal`

## Archivos

| Archivo | Qué hace |
| --- | --- |
| `main.swift` | Lectura de agentes, contexto, gasto y su nivel (port de `../vscode/sesiones.js`), ventana, Dock, barra de menú, ir a la pestaña. |
| `web/` | La vista: `index.html` (buscador, «Siempre visible») + `view.js`/`view.css` (copias de `../vscode/media/`: cambialos allá y copialos acá) y los sprites. |
| `armar.sh` | Compila (arm64 + x86_64), arma el `.app` con el ícono y lo firma ad hoc. |
