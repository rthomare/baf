.PHONY: all build web go clean dev

all: build

web:
	cd web && npm install && npm run build

go:
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o baf ./cmd/baf

build: web go

dev:
	cd web && npm install
	cd web && npm run dev &
	go run ./cmd/baf

clean:
	rm -rf baf web/dist web/node_modules
