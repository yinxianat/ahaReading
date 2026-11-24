// Stand-in parse worker that answers with an unknown error code and hostile text.
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ ok: false, code: "server_error<script>", message: "<b>raw parser text</b>", detail: "x".repeat(1000) });
