# Dungeon de agentes

Tus agentes de Claude Code como héroes pixel-art: una tarjeta por agente, en un cuarto que cambia según
lo que está haciendo (trabajando, te necesita, terminó, en pausa, sin cuota). Clic en una tarjeta te
lleva a ese agente.

| Carpeta | Qué es | Para quién |
| --- | --- | --- |
| [`vscode/`](vscode/) | Extensión de VS Code: una vista lateral con las tarjetas. | Quien usa Claude Code dentro de VS Code. |
| [`mac/`](mac/) | App nativa de macOS (Swift + WebKit, sin dependencias): ventana propia, ícono en el Dock y en la barra de menú, buscador y opción «Siempre visible». | Quien usa Claude Code en la Terminal (o en ambos). |

Las dos leen lo mismo: los agentes vivos de `~/.claude/sessions/<pid>.json` (el estado que publica Claude
Code) y el título, la rama y la herramienta en uso de su transcripción
(`~/.claude/projects/*/<sessionId>.jsonl`). La lógica está en `vscode/sesiones.js` y portada a Swift en
`mac/main.swift`: si cambiás una, cambiá la otra.

Cómo armar, instalar y diagnosticar cada una: en el README de su carpeta.

## Créditos

Sprites de los cuartos y héroes: [Agents Pixel Dungeon](https://github.com/JoseValencia125/agents-pixel-dungeon),
© 2026 Nacho Valencia · Diabolo Studio, licencia MIT.
