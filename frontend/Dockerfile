FROM nginx:alpine

RUN mkdir -p /usr/share/nginx/html

COPY index.html /usr/share/nginx/html/

RUN echo 'server { \
  listen 80; \
  server_name _; \
  location / { \
    root /usr/share/nginx/html; \
    try_files $uri /index.html; \
  } \
  location /api/ { \
    proxy_pass http://backend:3000/api/; \
    proxy_http_version 1.1; \
    proxy_set_header Upgrade $http_upgrade; \
    proxy_set_header Connection "upgrade"; \
    proxy_set_header Host $host; \
    proxy_cache_bypass $http_upgrade; \
  } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
