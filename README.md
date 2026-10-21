# Dungeon de agentes

Tus agentes de Claude Code como héroes pixel-art: una tarjeta por agente, en un cuarto que cambia según
lo que está haciendo (trabajando, te necesita, terminó, en pausa, sin cuota). Clic en una tarjeta te
lleva a ese agente.

| Carpeta | Qué es | Para quién |
| --- | --- | --- |
| [`vscode/`](vscode/) | Extensión de VS Code: una vista lateral con las tarjetas. | Quien usa Claude Code dentro de VS Code. |
| [`mac/`](mac/) | App nativa de macOS (Swift + WebKit, sin dependencias): ventana propia, ícono en el Dock y en la barra de menú, buscador y opción «Siempre visible». | Quien usa Claude Code en la Terminal (o en ambos). |

## Qué muestra cada tarjeta

- **El héroe en su cuarto**, según el estado del agente: TRABAJANDO (en el escritorio), TE NECESITA (con un
  «!», y la tarjeta late), TERMINÓ (festeja con un ✓), EN PAUSA (lee junto al fuego), SIN CUOTA (duerme en
  la enfermería: llegó al límite de uso del plan).
- **Su slime**, una mascota de un color propio por agente que reacciona al estado: da saltitos mientras
  trabaja, se esconde temblando detrás del héroe cuando te necesita, salta contento cuando terminó y duerme
  en pausa.
- **Franja de contexto** arriba de la tarjeta: cuánto de la ventana de contexto lleva usado la sesión
  («CONTEXTO 66 %»), azul, ámbar desde 70 % y roja titilando desde 90 %.
- **Pila de monedas con un cartelito** («≈ u$s 35,75»): cuánto «pesa» la sesión. Es el valor de sus tokens
  a precio de lista, **no un cobro** (con una suscripción no se paga por token). El tamaño de la pila y el
  color del monto dicen si es baja, media o alta **comparada con el uso de la propia persona** (ver abajo).
- **Ayuda al pasar el mouse**, con todos los datos de la sesión.
- Arriba, un **buscador** (nombre, carpeta o rama). Las tarjetas miden 220 px y se ponen una al lado de la
  otra si hay lugar.

## De dónde salen los datos

Todo sale de archivos que Claude Code ya guarda en tu Mac; no se consulta nada afuera.

| Dato | Fuente |
| --- | --- |
| Agentes vivos y su estado | `~/.claude/sessions/<pid>.json` (lo publica Claude Code por cada proceso: `busy` / `idle` / `waiting`) |
| Título, rama, herramienta en uso, límite de uso | la transcripción de la sesión, `~/.claude/projects/*/<sessionId>.jsonl` |
| Contexto usado | el `usage` de la última respuesta del agente (tokens nuevos + guardados); la ventana es de 1 millón en Opus 5.5 y Fable 5.1, y de 200 mil en el resto salvo que la sesión ya la haya pasado |
| Gasto | el último `cost-state` (`totalCostUSD`) que Claude Code anota de a ratos en la transcripción |
| Nivel del gasto | con 3 o más sesiones abiertas con gasto, se reparten en tercios entre ellas; con menos, se comparan con las sesiones de la misma persona de las últimas 2 semanas (recalculado cada hora); sin historial, sin nivel |

La lectura está en `vscode/sesiones.js` y portada a Swift en `mac/main.swift`; el dibujo
(`vscode/media/view.js` y `view.css`) es el mismo archivo en las dos (`mac/web/` es una copia). Si cambiás
una, cambiá la otra.

Cómo armar, instalar y diagnosticar cada una: en el README de su carpeta.

## Créditos

Los dibujos de los cuartos y los héroes son de **[Agents Pixel Dungeon](https://github.com/JoseValencia125/agents-pixel-dungeon)**,
© 2026 Nacho Valencia · [Diabolo Studio](https://diabolostudio.com/), con licencia MIT (ver
`LICENSE-agents-pixel-dungeon.txt` en `vscode/media/` y `mac/web/`). La idea de mostrar a los agentes
como héroes en un dungeon también viene de ese proyecto.

Este proyecto **no es oficial ni está afiliado** a Agents Pixel Dungeon, Diabolo Studio ni Anthropic: es
una reimplementación independiente (extensión de VS Code y app de macOS) que reusa esos dibujos. El código
de este repo es propio y tiene licencia MIT ([LICENSE](LICENSE)).

## Apoyar el proyecto

Si te sirve, podés invitarme un café (desde 1 dólar) por [PayPal](https://www.paypal.com/paypalme/peporiro), también
desde el botón **Sponsor** del repo.
