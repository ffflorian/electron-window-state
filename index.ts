import * as path from 'path';
import * as electron from 'electron';
import * as jsonfile from 'jsonfile';
import * as mkdirp from 'mkdirp';
import deepEqual = require('deep-equal');

export interface Options {
  /* The width that should be returned if no file exists yet. Defaults to `800`. */
  defaultWidth?: number;
  /* The height that should be returned if no file exists yet. Defaults to `600`. */
  defaultHeight?: number;
  /* The path where the state file should be written to. Defaults to `app.getPath('userData')` */
  path?: string;
  /* The name of file. Defaults to `window-state.json` */
  file?: string;
  /* Should we automatically maximize the window, if it was last closed maximized. Defaults to `true` */
  maximize?: boolean;
  fullScreen?: boolean;
}

export interface State {
  displayBounds: {
    height: number;
    width: number;
  };
  /* The saved x coordinate of the loaded state. `undefined` if the state has not been saved yet. */
  x: number;
  /* The saved y coordinate of the loaded state. `undefined` if the state has not been saved yet. */
  y: number;
  /* The saved width of loaded state. `defaultWidth` if the state has not been saved yet. */
  width: number;
  /* The saved heigth of loaded state. `defaultHeight` if the state has not been saved yet. */
  height: number;
  /* `true` if the window state was saved while the window was maximized. `undefined` if the state has not been saved yet. */
  isMaximized: boolean;
  /* true if the window state was saved while the window was in full screen mode. undefined if the state has not been saved yet. */
  isFullScreen: boolean;
  /* Register listeners on the given BrowserWindow for events that are related to size or position changes (resize, move). It will also restore the window's maximized or full screen state. When the window is closed we automatically remove the listeners and save the state. */
  manage: (window: electron.BrowserWindow) => void;
  /* Removes all listeners of the managed `BrowserWindow` in case it does not need to be managed anymore. */
  unmanage: () => void;
  /* Saves the current state of the given `BrowserWindow`. This exists mostly for legacy purposes, and in most cases it's better to just use `manage()`. */
  saveState: (window: electron.BrowserWindow) => void;
}

const app = electron.app || electron.remote.app;

const defaultOptions: Required<Options> = {
  defaultHeight: 600,
  defaultWidth: 800,
  file: 'window-state.json',
  fullScreen: true,
  maximize: true,
  path: app.getPath('userData'),
};

export class WindowStateKeeper {
  private config: Required<Options>;
  private eventHandlingDelay: number;
  private fullStoreFileName: string;
  private screen: electron.Screen;
  private state: State | null;
  private stateChangeTimer?: NodeJS.Timer | number;
  private winRef?: electron.BrowserWindow | null;

  constructor(options?: Options) {
    this.screen = electron.screen || electron.remote.screen;
    this.eventHandlingDelay = 100;
    this.state = null;
    this.config = Object.assign(
      defaultOptions,
      options,
    );
    this.fullStoreFileName = path.join(this.config.path, this.config.file);

    // Load previous state
    try {
      this.state = jsonfile.readFileSync(this.fullStoreFileName);
    } catch (err) {
      // Don't care
    }

    // Check state validity
    this.validateState();

    // Set state fallback values
    this.state = Object.assign(
      {
        width: this.config.defaultWidth,
        height: this.config.defaultHeight,
      },
      this.state,
    );
  }

  private isNormal(win: electron.BrowserWindow) {
    return !win.isMaximized() && !win.isMinimized() && !win.isFullScreen();
  }

  private hasBounds() {
    return (
      this.state &&
      Number.isInteger(this.state.x) &&
      Number.isInteger(this.state.y) &&
      Number.isInteger(this.state.width) &&
      this.state.width > 0 &&
      Number.isInteger(this.state.height) &&
      this.state.height > 0
    );
  }

  private validateState() {
    const isValid = this.state && (this.hasBounds() || this.state.isMaximized || this.state.isFullScreen);

    if (!isValid) {
      this.state = null;
      return;
    }

    if (this.state && this.hasBounds() && this.state.displayBounds) {
      // Check if the display where the window was last open is still available
      const displayBounds = this.screen.getDisplayMatching(this.state).bounds;
      const sameBounds = deepEqual(this.state.displayBounds, displayBounds, { strict: true });
      if (!sameBounds) {
        if (displayBounds.width < this.state.displayBounds.width) {
          if (this.state.x > displayBounds.width) {
            this.state.x = 0;
          }

          if (this.state.width > displayBounds.width) {
            this.state.width = displayBounds.width;
          }
        }

        if (displayBounds.height < this.state.displayBounds.height) {
          if (this.state.y > displayBounds.height) {
            this.state.y = 0;
          }

          if (this.state.height > displayBounds.height) {
            this.state.height = displayBounds.height;
          }
        }
      }
    }
  }

  private updateState(win?: electron.BrowserWindow | null) {
    win = win || this.winRef;
    if (!win || !this.state) {
      return;
    }
    // Don't throw an error when window was closed
    try {
      const winBounds = win.getBounds();
      if (this.isNormal(win)) {
        this.state.x = winBounds.x;
        this.state.y = winBounds.y;
        this.state.width = winBounds.width;
        this.state.height = winBounds.height;
      }
      this.state.isMaximized = win.isMaximized();
      this.state.isFullScreen = win.isFullScreen();
      this.state.displayBounds = this.screen.getDisplayMatching(winBounds).bounds;
    } catch (err) {}
  }

  public saveState(win?: electron.BrowserWindow) {
    // Update window state only if it was provided
    if (win) {
      this.updateState(win);
    }

    // Save state
    try {
      mkdirp.sync(path.dirname(this.fullStoreFileName));
      jsonfile.writeFileSync(this.fullStoreFileName, this.state);
    } catch (err) {
      // Don't care
    }
  }

  private stateChangeHandler() {
    // Handles both 'resize' and 'move'
    clearTimeout(this.stateChangeTimer as number);
    this.stateChangeTimer = setTimeout(this.updateState, this.eventHandlingDelay);
  }

  private closeHandler() {
    this.updateState();
  }

  private closedHandler() {
    // Unregister listeners and save state
    this.unmanage();
    this.saveState();
  }

  public manage(win: electron.BrowserWindow) {
    if (this.config.maximize && this.state && this.state.isMaximized) {
      win.maximize();
    }
    if (this.config.fullScreen && this.state && this.state.isFullScreen) {
      win.setFullScreen(true);
    }
    win.on('resize', this.stateChangeHandler);
    win.on('move', this.stateChangeHandler);
    win.on('close', this.closeHandler);
    win.on('closed', this.closedHandler);
    this.winRef = win;
  }

  public unmanage() {
    if (this.winRef) {
      this.winRef.removeListener('resize', this.stateChangeHandler);
      this.winRef.removeListener('move', this.stateChangeHandler);
      clearTimeout(this.stateChangeTimer as number);
      this.winRef.removeListener('close', this.closeHandler);
      this.winRef.removeListener('closed', this.closedHandler);
      this.winRef = null;
    }
  }

  get x() {
    return this.state && this.state.x;
  }
  get y() {
    return this.state && this.state.y;
  }
  get width() {
    return this.state && this.state.width;
  }
  get height() {
    return this.state && this.state.height;
  }
  get isMaximized() {
    return this.state && this.state.isMaximized;
  }
  get isFullScreen() {
    return this.state && this.state.isFullScreen;
  }
};

export function newManager(options?: Options): WindowStateKeeper {
  return new WindowStateKeeper(options);
}

export default newManager;
