# AutoReload Extension

AutoReload Firefox extension, built to enable the ability to reload browser tabs automatically after a specified interval. Idle timeout support. Built in typescript using react, webpack, bootstrap, and browser runtime API.

![screenshot](./docs/screenshot.png)
![screenshot](./docs/screenshot2.png)

## Countdown badge: see when the next auto refresh happens

Show the time until the next reload on the toolbar icon, so you can see the refresh timer without opening the popup. It is on by default (untick **Show countdown on toolbar icon** in Settings to turn it off). Each tab with auto reload on then displays a green badge such as `89s`, `4m` or `2h`, counting down to its next reload, and its tooltip says how often it reloads and when the next reload is. If auto reload was switched off because you were away (idle timeout) the badge shows an orange `II`; while a failed page waits to be retried it shows `R`. The badge is per tab and is removed when auto reload is switched off for that tab or the tab is closed.

Handy when you run several refreshing tabs (dashboards, monitoring and status pages, live scores, CI pages) or a kiosk display and want to know at a glance that the page is still being kept fresh. It needs no extra permissions.

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
