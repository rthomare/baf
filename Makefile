.PHONY: all build web go clean dev

all: build

web:
	cd web && npm install && npm run build

go:
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o baf ./cmd/baf

build: web go

dev:
	@cd web && npm install
	@echo "starting vite dev server on :5173"
	@(cd web && npm run dev -- --port 5173 --strictPort) & \
		VITE_PID=$$!; \
		trap "kill $$VITE_PID 2>/dev/null" EXIT INT TERM; \
		until curl -fsS http://localhost:5173/ >/dev/null 2>&1; do sleep 0.2; done; \
		echo "vite up; starting baf in BAF_DEV mode"; \
		BAF_DEV=http://localhost:5173 go run ./cmd/baf

clean:
	rm -rf baf web/dist web/node_modules
