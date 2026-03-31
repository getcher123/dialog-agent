import WebSocket from "ws";

const targetUrl = process.env.WS_URL || "ws://127.0.0.1:3300/ws";
const prompt =
  process.env.TEXT_TURN ||
  "Подробно расскажи про флеш-отбеливание зубов десятью предложениями, с этапами, подготовкой, противопоказаниями и уходом после процедуры.";

const startedAt = Date.now();
const events = [];
let sent = false;
let interrupted = false;

function stamp(name, extra = {}) {
  events.push({
    at: Date.now() - startedAt,
    name,
    ...extra
  });
}

const ws = new WebSocket(targetUrl);

function finish() {
  console.log(
    JSON.stringify(
      {
        targetUrl,
        prompt,
        interrupted,
        events
      },
      null,
      2
    )
  );
  ws.close();
}

ws.on("message", (raw, isBinary) => {
  if (isBinary) {
    stamp("audio.chunk", {
      bytes: raw.byteLength
    });
    return;
  }

  const event = JSON.parse(raw.toString());

  if (event.type === "connection.ready" && !sent) {
    sent = true;
    stamp("connection.ready");
    ws.send(
      JSON.stringify({
        type: "text.turn",
        text: prompt
      })
    );
    stamp("text.turn.sent");
    return;
  }

  if (event.type === "audio.response.start" && !interrupted) {
    interrupted = true;
    stamp("audio.start");
    ws.send(
      JSON.stringify({
        type: "turn.interrupt",
        reason: "Smoke interrupt."
      })
    );
    stamp("turn.interrupt.sent");
    return;
  }

  if (event.type === "server.status") {
    stamp("server.status", {
      phase: event.phase,
      detail: event.detail
    });

    if (
      interrupted &&
      /Interrupt requested|interrupted by user speech|Listening for the next utterance/i.test(
        event.detail
      )
    ) {
      setTimeout(finish, 300);
    }
    return;
  }

  if (event.type === "server.error") {
    stamp("server.error", {
      message: event.message
    });
    setTimeout(finish, 100);
  }
});

ws.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
