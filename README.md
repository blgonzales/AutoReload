# AutoReload Extension

AutoReload Firefox extension, built to enable the ability to reload browser tabs automatically after a specified interval. Idle timeout support. Built in typescript using react, webpack, bootstrap, and browser runtime API.

![screenshot](./docs/screenshot.png)
![screenshot](./docs/screenshot2.png)

## Auto retry failed pages (HTTP 504, 503, 429 and other errors)

AutoReload can keep trying a page that comes back with a server error, so a flaky page recovers on its own instead of staying on an error screen. It is off by default. Turn it on in Settings by ticking **Retry pages that fail with an HTTP error**, then choose:

- **Status codes**: tick common ones (408, 429, 500, 502, 503, 504, Cloudflare 520-524; 502/503/504 are pre-selected) and/or type your own, e.g. `418, 525-527`.
- **Retry delay**: 5 seconds to 1 hour.
- **Back off** (optional): double the delay after each failed retry, up to a limit you pick. A `Retry-After` header asking for longer is honoured (up to 1 hour).

Good for status pages, dashboards and wallboards behind an unreliable proxy, and for pages that are briefly overloaded (ticket or stock availability, live scores, CI pages). Only GET page loads are retried, so a form submission is never re-sent. It also works on sites served through a service worker (offline or caching add-ons, installable web apps), where the status code is read from the loaded page.

Permissions: reading response status codes needs the optional `webRequest` permission for all sites. Firefox asks only when you first switch the setting on; if you never enable it, nothing changes.

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
