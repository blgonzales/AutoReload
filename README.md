# AutoReload Extension

AutoReload Firefox extension, built to enable the ability to reload browser tabs automatically after a specified interval. Idle timeout support. Built in typescript using react, webpack, bootstrap, and browser runtime API.

![screenshot](./docs/screenshot.png)
![screenshot](./docs/screenshot2.png)

## Works with Auto Tab Discard: keep reloading tabs loaded (tab discarding, memory saver)

Add-ons such as Auto Tab Discard, and Firefox's own memory saver, unload ("discard") background tabs that have been idle for a while. A tab that is only restored from the unloaded state is not fetched from the server, so an auto-reloading tab could silently stop updating.

AutoReload now keeps the tabs it is reloading loaded. This is on by default; the checkbox **Keep reloading tabs loaded** in Settings turns it off.

- While AutoReload is running for a tab, that tab is marked "do not discard" (the standard `autoDiscardable` flag, which Firefox and Auto Tab Discard both respect). When you turn AutoReload off for the tab, or close it, the previous value is restored. A tab you already marked "keep" yourself is left as it was.
- If a tab is unloaded anyway (for example by hand), the next scheduled reload loads it and then reloads it again so the page really comes from the server.
- No new permission is needed. Firefox 116 or newer is required for the flag; on older versions AutoReload behaves as before.

Official firefox addon listing: https://addons.mozilla.org/en-US/firefox/addon/auto-reload/

## Dependencies

- Node 19.x https://nodejs.org/en/download
- Yarn
- Firefox
- Linux/Windows WSL/Mac OSX supported

## Local Setup

### Install

`yarn install`

### Development

Using webpack dev server and the watch command, the popup is served to the browser for some development. Files are watched and the page will reload when saved.

`yarn run dev`

### Build App

`yarn run build`

Which creates `dist/app.js` which is the entrypoint (background) and `dist/popup.js`

### Build Signed App

- Install `direnv`
- Create an `.envrc` file from `.envrc.example` in the root
- Enter the app credentials in the `.envrc` file
- Optionally run `direnv allow` in the root directory if you didn't install the recommended direnv extension
- Update the version in `manifest.json`
- Run `yarn run build-signed`
- A new `.xpi` file should be created in `./release` if successful

## Docker Setup (optional)

- Install docker
- Build the container using `docker-compose build`

### Dev environment through docker

`docker-compose up`

### Build with docker

Builds temporary extension in the `./dist`` folder

- Run `docker-compose -f docker-compose.yml -f docker-compose.build.yml up --build`

# Testing in Firefox

Go to `about:debugging#/runtime/this-firefox` and the select 'Load Temporary Add-on' and the select manifest.json in the `dist` directory.

# Resources

- https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#global-options
- https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/#using-web-ext-section
