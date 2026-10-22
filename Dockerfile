FROM node:22-alpine AS frontend
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM golang:1.26-alpine AS backend
WORKDIR /build
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /wejay .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && addgroup -S wejay && adduser -S wejay -G wejay
WORKDIR /app
COPY --from=backend /wejay ./wejay
COPY --from=frontend /build/dist ./dist
RUN mkdir data && chown wejay:wejay data
USER wejay
ENV LISTEN_ADDR=:8080 STATIC_DIR=/app/dist USER_DATA_FILE=/app/data/users.json
EXPOSE 8080
CMD ["./wejay"]