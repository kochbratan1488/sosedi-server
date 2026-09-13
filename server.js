const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const rooms = new Map();

function makeRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {
        code = "";

        for (let i = 0; i < 6; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
    } while (rooms.has(code));

    return code;
}

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(room, data) {
    send(room.host, data);
    send(room.guest, data);
}

const server = http.createServer((req, res) => {
    let urlPath = req.url.split("?")[0];

    if (urlPath === "/" || urlPath === "/index.html") {
        const file = path.join(__dirname, "index.html");

        fs.readFile(file, (err, data) => {
            if (err) {
                res.writeHead(500, {
                    "Content-Type": "text/plain; charset=utf-8"
                });
                res.end("Не удалось загрузить index.html");
                return;
            }

            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8"
            });
            res.end(data);
        });

        return;
    }

    res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
    });
    res.end("Not found");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
    ws.room = null;
    ws.role = null;

    send(ws, {
        type: "connected"
    });

    ws.on("message", (raw) => {
        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (data.type === "create") {
            if (ws.room) return;

            const code = makeRoomCode();

            const room = {
                host: ws,
                guest: null,
                score: 0,
                turn: "host",
                question: null
            };

            rooms.set(code, room);

            ws.room = code;
            ws.role = "host";

            send(ws, {
                type: "roomCreated",
                room: code
            });

            return;
        }

        if (data.type === "join") {
            const code = String(data.room || "").toUpperCase();
            const room = rooms.get(code);

            if (!room) {
                send(ws, {
                    type: "error",
                    message: "Комната не найдена."
                });
                return;
            }

            if (room.guest) {
                send(ws, {
                    type: "error",
                    message: "В этой комнате уже есть два игрока."
                });
                return;
            }

            room.guest = ws;
            ws.room = code;
            ws.role = "guest";

            send(ws, {
                type: "joined",
                room: code
            });

            send(room.host, {
                type: "roomReady"
            });

            return;
        }

        const room = ws.room ? rooms.get(ws.room) : null;

        if (!room) {
            send(ws, {
                type: "error",
                message: "Сначала создай комнату или войди в неё."
            });
            return;
        }

        if (data.type === "question") {
            if (ws !== room.host) return;

            room.question = data.question;
            room.score = Number(data.score) || 0;
            room.turn = data.turn === "guest" ? "guest" : "host";

            broadcast(room, {
                type: "question",
                question: room.question,
                score: room.score,
                turn: room.turn,
                center: data.center,
                zoom: data.zoom
            });

            return;
        }

        if (data.type === "answer") {
            if (ws.role !== room.turn) return;

            const correct = Boolean(data.correct);

            if (correct) {
                room.score++;
            }

            room.turn =
                room.turn === "host"
                    ? "guest"
                    : "host";

            broadcast(room, {
                type: "answer",
                score: room.score,
                correct,
                result: String(data.result || ""),
                nextTurn: room.turn
            });

            return;
        }

        if (data.type === "next") {
            if (ws.role !== room.turn) return;
            if (ws !== room.host) {
                // Guest asks host to generate the next question.
                send(room.host, {
                    type: "makeNextQuestion",
                    turn: "guest"
                });
            } else {
                send(room.host, {
                    type: "makeNextQuestion",
                    turn: "host"
                });
            }

            return;
        }

        if (data.type === "map") {
            const other =
                ws === room.host
                    ? room.guest
                    : room.host;

            send(other, {
                type: "map",
                lat: Number(data.lat),
                lng: Number(data.lng),
                zoom: Number(data.zoom)
            });

            return;
        }

        if (data.type === "input") {
            const other =
                ws === room.host
                    ? room.guest
                    : room.host;

            send(other, {
                type: "input",
                country: String(data.country || ""),
                capital: String(data.capital || "")
            });

            return;
        }
    });

    ws.on("close", () => {
        const code = ws.room;
        const room = code ? rooms.get(code) : null;

        if (!room) return;

        const other =
            ws === room.host
                ? room.guest
                : room.host;

        if (other) {
            send(other, {
                type: "left"
            });
        }

        if (ws === room.host) {
            rooms.delete(code);
        } else {
            room.guest = null;
        }
    });
});

// Keep WebSocket connections alive on hosts that support long-lived connections.
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            ws.terminate();
            return;
        }

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on("connection", (ws) => {
    ws.isAlive = true;

    ws.on("pong", () => {
        ws.isAlive = true;
    });
});

wss.on("close", () => {
    clearInterval(heartbeat);
});

server.listen(PORT, HOST, () => {
    console.log(`Соседи России server listening on ${HOST}:${PORT}`);
});
