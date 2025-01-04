/// <reference types="vite/client" />
import { createReadableStreamFromReadable, createRequestHandler } from '@remix-run/node';
import type { ServerBuild } from '@remix-run/node';
import electron, { app, BrowserWindow, ipcMain, Menu, protocol } from 'electron';
import log from 'electron-log'; // write logs into ${app.getPath("logs")}/main.log without `/main`.
import ElectronStore from 'electron-store';
import mime from 'mime';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { ViteDevServer } from 'vite';
// eslint-disable-next-line no-restricted-imports
import * as pkg from '../../package.json';
import { setupAutoUpdater } from './auto-update';

// Conditionally import Vite only in development
let viteServer: ViteDevServer | undefined;
const initViteServer = async () => {
  if (!(global.process.env.NODE_ENV === 'production' || app.isPackaged)) {
    const vite = await import('vite');
    viteServer = await vite.createServer({
      root: '.',
      envDir: path.join(__dirname, '../..'), // load .env files from the root directory.
    });
  }
};

Object.assign(console, log.functions);

console.debug('main: import.meta.env:', import.meta.env);

const __dirname = fileURLToPath(import.meta.url);
const isDev = !(global.process.env.NODE_ENV === 'production' || app.isPackaged);

async function appLogger(...args: any[]) {
  const message = args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg)).join(' ');
  console.log(message);
}

appLogger('main: isDev:', isDev);
appLogger('NODE_ENV:', global.process.env.NODE_ENV);
appLogger('isPackaged:', app.isPackaged);

const DEFAULT_PORT = 8080;

// Log unhandled errors
process.on('uncaughtException', async (error) => {
  await appLogger('Uncaught Exception:', error);
});

process.on('unhandledRejection', async (error) => {
  await appLogger('Unhandled Rejection:', error);
});

(() => {
  const root = global.process.env.APP_PATH_ROOT ?? import.meta.env.VITE_APP_PATH_ROOT;

  if (root === undefined) {
    appLogger('no given APP_PATH_ROOT or VITE_APP_PATH_ROOT. default path is used.');
    return;
  }

  if (!path.isAbsolute(root)) {
    appLogger('APP_PATH_ROOT must be absolute path.');
    global.process.exit(1);
  }

  appLogger(`APP_PATH_ROOT: ${root}`);

  const subdirName = pkg.name;

  for (const [key, val] of [
    ['appData', ''],
    ['userData', subdirName],
    ['sessionData', subdirName],
  ] as const) {
    app.setPath(key, path.join(root, val));
  }

  app.setAppLogsPath(path.join(root, `${subdirName}/Logs`));
})();

appLogger('appPath:', app.getAppPath());

const keys: Parameters<typeof app.getPath>[number][] = ['home', 'appData', 'userData', 'sessionData', 'logs', 'temp'];
keys.forEach((key) => appLogger(`${key}:`, app.getPath(key)));

const store = new ElectronStore<any>({ encryptionKey: 'something' });

const createWindow = async (rendererURL: string) => {
  appLogger('Creating window with URL:', rendererURL);

  const bounds = store.get('bounds');
  appLogger('restored bounds:', bounds);

  const win = new BrowserWindow({
    ...{
      width: 1200,
      height: 800,
      ...bounds,
    },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
    },
  });

  appLogger('Window created, loading URL...');
  win.loadURL(rendererURL).catch((err) => {
    appLogger('Failed to load URL:', err);
  });

  win.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
    appLogger('Failed to load:', errorCode, errorDescription);
  });

  win.webContents.on('did-finish-load', () => {
    appLogger('Window finished loading');
  });

  // Open devtools in development
  if (isDev) {
    win.webContents.openDevTools();
  }

  const boundsListener = () => {
    const bounds = win.getBounds();
    store.set('bounds', bounds);
  };
  win.on('moved', boundsListener);
  win.on('resized', boundsListener);

  return win;
};

appLogger('start whenReady');

const rendererClientPath = isDev ? path.join(__dirname, '../../client') : path.join(app.getAppPath(), 'build/client');

declare global {
  // eslint-disable-next-line no-var, @typescript-eslint/naming-convention
  var __electron__: typeof electron;
}

async function loadServerBuild(): Promise<any> {
  if (isDev) {
    appLogger('Dev mode: server build not loaded');
    return;
  }

  const serverBuildPath = path.join(app.getAppPath(), 'build/server/index.js');
  appLogger(`Loading server build... path is ${serverBuildPath}`);

  try {
    const fileUrl = pathToFileURL(serverBuildPath).href;
    const serverBuild: ServerBuild = /** @type {ServerBuild} */ await import(fileUrl);
    appLogger('Server build loaded successfully');

    // eslint-disable-next-line consistent-return
    return serverBuild;
  } catch (buildError) {
    appLogger('Failed to load server build:', {
      message: (buildError as Error)?.message,
      stack: (buildError as Error)?.stack,
      error: JSON.stringify(buildError, Object.getOwnPropertyNames(buildError as object)),
    });

    return;
  }
}

(async () => {
  await app.whenReady();
  appLogger('App is ready');

  const serverBuild = await loadServerBuild();

  protocol.handle('http', async (req) => {
    appLogger('Handling request for:', req.url);

    if (isDev) {
      appLogger('Dev mode: forwarding to vite server');
      return await fetch(req);
    }

    req.headers.append('Referer', req.referrer);

    try {
      const url = new URL(req.url);

      // Forward requests to specific local server ports
      if (url.port !== `${DEFAULT_PORT}`) {
        appLogger('Forwarding request to local server:', req.url);
        return await fetch(req);
      }

      // Always try to serve asset first
      const res = await serveAsset(req, rendererClientPath);

      if (res) {
        appLogger('Served asset:', req.url);
        return res;
      }

      // Create request handler with the server build
      const handler = createRequestHandler(serverBuild, 'production');
      appLogger('Handling request with server build:', req.url);

      const result = await handler(req, {
        // @ts-ignore:next-line
        cloudflare: {},
      });

      if (result.status >= 400) {
        const body = await result.text();
        appLogger('Error response from handler:', {
          url: req.url,
          status: result.status,
          body,
        });
      }

      return result;
    } catch (err) {
      appLogger('Error handling request:', {
        url: req.url,
        error:
          err instanceof Error
            ? {
                message: err.message,
                stack: err.stack,
                cause: err.cause,
              }
            : err,
      });

      const { stack, message } = toError(err);

      return new Response(`Error handling request to ${req.url}: ${stack ?? message}`, {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      });
    }
  });

  const rendererURL = await (isDev
    ? (async () => {
        await initViteServer();

        if (!viteServer) {
          throw new Error('Vite server is not initialized');
        }

        const listen = await viteServer.listen();
        global.__electron__ = electron;
        viteServer.printUrls();

        return `http://localhost:${listen.config.server.port}`;
      })()
    : `http://localhost:${DEFAULT_PORT}`);

  appLogger('Using renderer URL:', rendererURL);

  const win = await createWindow(rendererURL);

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow(rendererURL);
    }
  });

  appLogger('end whenReady');

  return win;
})()
  .then((win) => {
    // IPC samples : send and recieve.
    let count = 0;
    setInterval(() => win.webContents.send('ping', `hello from main! ${count++}`), 60 * 1000);
    ipcMain.handle('ipcTest', (event, ...args) => appLogger('ipc: renderer -> main', { event, ...args }));

    return win;
  })
  .then((win) => setupMenu(win));

/*
 *
 * Menu: append Go -> Back, Forward
 *
 */
const setupMenu = (win: BrowserWindow): void => {
  const app = Menu.getApplicationMenu();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(app ? app.items : []),
      {
        label: 'Go',
        submenu: [
          {
            label: 'Back',
            accelerator: 'CmdOrCtrl+[',
            click: () => {
              win?.webContents.navigationHistory.goBack();
            },
          },
          {
            label: 'Forward',
            accelerator: 'CmdOrCtrl+]',
            click: () => {
              win?.webContents.navigationHistory.goForward();
            },
          },
        ],
      },
    ]),
  );
};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/*
 *
 * take care of vite-dev-server.
 *
 */
app.on('before-quit', async (_event) => {
  if (!viteServer) {
    return;
  }

  /*
   * ref: https://stackoverflow.com/questions/68750716/electron-app-throwing-quit-unexpectedly-error-message-on-mac-when-quitting-the-a
   * event.preventDefault();
   */
  try {
    appLogger('will close vite-dev-server.');
    await viteServer.close();
    appLogger('closed vite-dev-server.');

    // app.quit(); // Not working. causes recursively 'before-quit' events.
    app.exit(); // Not working expectedly SOMETIMES. Still throws exception and macOS shows dialog.
    // global.process.exit(0); // Not working well... I still see exceptional dialog.
  } catch (err) {
    appLogger('failed to close Vite server:', err);
  }
});

// serve assets built by vite.
export async function serveAsset(req: Request, assetsPath: string): Promise<Response | undefined> {
  const url = new URL(req.url);
  const fullPath = path.join(assetsPath, decodeURIComponent(url.pathname));
  appLogger('Serving asset, path:', fullPath);

  if (!fullPath.startsWith(assetsPath)) {
    appLogger('Path is outside assets directory:', fullPath);
    return;
  }

  const stat = await fs.stat(fullPath).catch((err) => {
    appLogger('Failed to stat file:', fullPath, err);
    return undefined;
  });

  if (!stat?.isFile()) {
    appLogger('Not a file:', fullPath);
    return;
  }

  const headers = new Headers();
  const mimeType = mime.getType(fullPath);

  if (mimeType) {
    headers.set('Content-Type', mimeType);
  }

  appLogger('Serving file with mime type:', mimeType);

  const body = createReadableStreamFromReadable(createReadStream(fullPath));

  // eslint-disable-next-line consistent-return
  return new Response(body, { headers });
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}

// Reload on change.
let isQuited = false;

const abort = new AbortController();
const { signal } = abort;

(async () => {
  const dir = path.join(__dirname, '../../build/electron');

  try {
    const watcher = fs.watch(dir, { signal, recursive: true });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _event of watcher) {
      if (!isQuited) {
        isQuited = true;
        app.relaunch();
        app.quit();
      }
    }
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    }

    if (err.name === 'AbortError') {
      appLogger('abort watching:', dir);
      return;
    }
  }
})();

setupAutoUpdater();
