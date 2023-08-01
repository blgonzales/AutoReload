FROM --platform=linux/amd64 node:19-alpine as base
ARG ENV

WORKDIR /app

COPY package.json .
COPY yarn.lock .
COPY ./package.json .

RUN if [ "$ENV" = "build" ] ; then yarn install --production ; else yarn install ; fi

COPY . .


## Dev environment
FROM base as dev
EXPOSE 9000
CMD yarn dev


## Build only
FROM base as build
CMD yarn build