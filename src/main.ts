import { Game } from "./game";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const errorEl = document.getElementById("error") as HTMLDivElement;

function showError(msg: string) {
  canvas.style.display = "none";
  errorEl.style.display = "flex";
  errorEl.textContent = msg;
}

Game.create(canvas).catch((e: Error) => showError(e.message));
