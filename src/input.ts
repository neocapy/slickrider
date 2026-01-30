export enum Action {
  Up,
  Down,
  Left,
  Right,
  Jump,
  Pause,
  DebugMoveUp,
  DebugMoveDown,
  COUNT,
}

const PRESS_THRESHOLD = 0.5;
const STICK_DEADZONE = 0.3;

const KEY_BINDINGS = new Map<string, Action>([
  ["KeyW", Action.Up],
  ["KeyS", Action.Down],
  ["KeyA", Action.Left],
  ["KeyD", Action.Right],
  ["Space", Action.Jump],
  ["Escape", Action.Pause],
  ["KeyE", Action.DebugMoveUp],
  ["KeyQ", Action.DebugMoveDown],
]);

// Standard gamepad button -> action
const BUTTON_BINDINGS = new Map<number, Action>([
  [0, Action.Jump],     // A
  [9, Action.Pause],    // Start / Menu
  [12, Action.Up],      // D-pad up
  [13, Action.Down],    // D-pad down
  [14, Action.Left],    // D-pad left
  [15, Action.Right],   // D-pad right
]);

export class Input {
  private current = new Float32Array(Action.COUNT);
  private previous = new Float32Array(Action.COUNT);
  private heldKeys = new Set<string>();
  private gamepadIndex: number | null = null;

  private mouseDX = 0;
  private mouseDY = 0;
  private frameMouseDX = 0;
  private frameMouseDY = 0;
  private mouseDown = false;

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("gamepadconnected", this.onGamepadConnected);
    window.addEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("mousemove", this.onMouseMove);
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("gamepadconnected", this.onGamepadConnected);
    window.removeEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("mousemove", this.onMouseMove);
  }

  mouseDelta(): [number, number] {
    return [this.frameMouseDX, this.frameMouseDY];
  }

  update(): void {
    this.previous.set(this.current);
    this.current.fill(0);

    this.frameMouseDX = this.mouseDX;
    this.frameMouseDY = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;

    // Keyboard
    for (const [code, action] of KEY_BINDINGS) {
      if (this.heldKeys.has(code)) {
        this.current[action] = 1.0;
      }
    }

    // Gamepad
    if (this.gamepadIndex !== null) {
      const gp = navigator.getGamepads()[this.gamepadIndex];
      if (gp) {
        this.pollGamepad(gp);
      }
    }
  }

  value(action: Action): number {
    return this.current[action];
  }

  isPressed(action: Action): boolean {
    return this.current[action] >= PRESS_THRESHOLD;
  }

  justPressed(action: Action): boolean {
    return this.current[action] >= PRESS_THRESHOLD && this.previous[action] < PRESS_THRESHOLD;
  }

  justReleased(action: Action): boolean {
    return this.current[action] < PRESS_THRESHOLD && this.previous[action] >= PRESS_THRESHOLD;
  }

  private pollGamepad(gp: Gamepad): void {
    // Buttons
    for (const [index, action] of BUTTON_BINDINGS) {
      if (index < gp.buttons.length) {
        this.current[action] = Math.max(this.current[action], gp.buttons[index].value);
      }
    }

    // Left stick
    if (gp.axes.length >= 2) {
      const x = gp.axes[0];
      const y = gp.axes[1];

      if (Math.abs(x) > STICK_DEADZONE) {
        const v = (Math.abs(x) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
        const action = x < 0 ? Action.Left : Action.Right;
        this.current[action] = Math.max(this.current[action], v);
      }

      if (Math.abs(y) > STICK_DEADZONE) {
        const v = (Math.abs(y) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
        // Gamepad Y axis: negative = up, positive = down
        const action = y < 0 ? Action.Up : Action.Down;
        this.current[action] = Math.max(this.current[action], v);
      }
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (KEY_BINDINGS.has(e.code)) {
      e.preventDefault();
      this.heldKeys.add(e.code);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.heldKeys.delete(e.code);
  };

  private onGamepadConnected = (e: GamepadEvent): void => {
    this.gamepadIndex = e.gamepad.index;
  };

  private onGamepadDisconnected = (e: GamepadEvent): void => {
    if (this.gamepadIndex === e.gamepad.index) {
      this.gamepadIndex = null;
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = true;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.mouseDown) {
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    }
  };
}
