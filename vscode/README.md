# Dungeon de agentes (extensión de VS Code)

Cada agente de Claude Code que está corriendo es una tarjeta cuadrada con un héroe pixel-art en un cuarto
que cambia según lo que está haciendo. Aparece con el ícono del personajito en la barra de la izquierda.

| Estado | Cuándo |
| --- | --- |
| TRABAJANDO | Claude informa `busy` |
| TE NECESITA | Claude informa `waiting`, o te hizo una pregunta / espera que apruebes un plan |
| TERMINÓ | Claude informa `idle` desde hace menos de 20 min |
| EN PAUSA | `idle` desde hace más de 20 min, o pestaña pineada sin agente corriendo |
| SIN CUOTA | Llegó al límite de uso |

Cada tarjeta suma el **slime** del agente, la **franja de contexto** arriba y la **pila de monedas con
el gasto** («≈ u$s», a precio de lista, con su nivel comparado con tus otras sesiones); al pasar el mouse
aparecen todos los datos. Qué es cada cosa y de dónde sale: en el [README principal](../README.md).

- Orden: primero las conversaciones **pineadas** (📌), después las que te necesitan.
- Tarjetas de 220 px como mínimo: si agrandás la barra lateral se ponen una al lado de la otra, y siempre se estiran para llenar el ancho.
- **Buscador** arriba de todo: filtra por nombre, carpeta o rama (sin importar mayúsculas ni acentos);
  empezar a escribir con la vista activa va directo a él, Esc lo borra.
- Clic en una tarjeta: abre esa conversación, también si es de otra carpeta (trae al frente o abre la
  ventana de VS Code de esa carpeta, y esa ventana abre la sesión).
- Si el agente corre en la **Terminal** (o iTerm2), el clic te lleva a su pestaña. La primera vez macOS
  pide que Visual Studio Code pueda controlar la Terminal y que tenga permiso de **Accesibilidad** (la
  Terminal solo deja cambiar de pestaña desde su menú Ventana). Lógica en `terminal.js`.
- Requisitos: la extensión de **Claude Code** para VS Code, y macOS o Linux (en Windows las pineadas no
  se reconocen: se leen con `sqlite3`).

## Cómo está armada

| Archivo | Qué hace |
| --- | --- |
| `package.json` | Declara la vista lateral (`dungeonAgentes.view`). |
| `extension.js` | Arranca la vista, refresca cada 2 s, abre sesiones (también en otra ventana, vía `abrir-sesion.json` en el `globalStorage`), y publica las pestañas pineadas de cada ventana (`pineadas/<pid>.json`). |
| `sesiones.js` | Lee los agentes vivos de `~/.claude/sessions/<pid>.json` (estado que publica Claude Code) y de su transcripción (`~/.claude/projects/*/<sessionId>.jsonl`) el título, la rama, la herramienta en uso, el contexto y el gasto; calcula el nivel del gasto (comparado con las otras sesiones o con el historial de 2 semanas). No depende de VS Code: se puede probar con Node. |
| `terminal.js` | Lleva a la pestaña de Terminal o iTerm2 donde corre un agente. |
| `media/view.js`, `media/view.css` | Dibujan las tarjetas (canvas): cuarto, héroe, slime, pila de monedas, cartelito, franja de contexto, buscador y la ayuda al pasar el mouse. La app de macOS usa una copia (`../mac/web/`). |
| `media/*.png` | Sprites de Agents Pixel Dungeon. |

## Si algo falla

- **Errores de la extensión:** Cmd+Shift+P → «Developer: Show Logs…» → «Extension Host». Buscá
  `dungeon-de-agentes`.
- **Errores del dibujo (tarjetas en blanco, etc.):** con la vista abierta, Cmd+Shift+P → «Developer: Open
  Webview Developer Tools» → pestaña Console.
- **Ver qué agentes detecta y en qué estado**, sin VS Code (desde esta carpeta, con Node 18 o más):

  ```bash
  node -e 'for (const s of require("./sesiones").leerSesiones()) console.log(s.estado, "|", s.titulo, "|", s.costo, s.nivelGasto, "|", s.contexto, "/", s.ventana)'
  ```

- Después de instalar una versión nueva, recargá **cada** ventana de VS Code (Cmd+Shift+P → «Developer:
  Reload Window»): una ventana sin recargar sigue con la versión vieja.

## Probar un cambio

1. Editá los archivos de esta carpeta.
2. Empaquetá e instalá (Node 18 o más):

   ```bash
   npx --yes @vscode/vsce@3.2.1 package --allow-missing-repository --skip-license -o dungeon-de-agentes.vsix
   code --install-extension dungeon-de-agentes.vsix --force
   ```

   (Si el comando `code` abre otro editor, usá el de VS Code:
   `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"`.)
3. Recargá la ventana. Subí el `version` de `package.json` en cada cambio para que VS Code lo tome.

## Créditos

Sprites de los cuartos y héroes: [Agents Pixel Dungeon](https://github.com/JoseValencia125/agents-pixel-dungeon),
© 2026 Nacho Valencia · Diabolo Studio, licencia MIT (ver `media/LICENSE-agents-pixel-dungeon.txt`).
Esta extensión no es oficial ni está afiliada a Agents Pixel Dungeon, Diabolo Studio ni Anthropic.
