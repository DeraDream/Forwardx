# Frontend build stage
FROM node:20-alpine AS frontend
WORKDIR /app
ENV HUSKY=0
RUN corepack enable && corepack prepare pnpm@8.15.6 --activate
COPY webs/package.json ./
RUN pnpm install --no-frozen-lockfile
COPY webs/ .
RUN pnpm exec vite build --mode production

# Go build stage
FROM golang:1.22.2-alpine AS builder
WORKDIR /app
COPY . .
COPY --from=frontend /app/dist ./static
RUN go mod download
RUN go build -o sublinkX

# Final stage
FROM alpine:latest
WORKDIR /app

# 设置时区为 Asia/Shanghai
ENV TZ=Asia/Shanghai

# 部分环境需要手动创建目录
RUN mkdir -p /app/db /app/logs /app/template && chmod 777 /app/db /app/logs /app/template

COPY --from=builder /app/sublinkX /app/sublinkX
EXPOSE 8000
CMD ["/app/sublinkX"]
