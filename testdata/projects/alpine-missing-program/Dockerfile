FROM node:22-alpine
# The project's own image installs git here; js-prueffactory does not run this
# Dockerfile, it only reads the base image from it.
RUN apk add --no-cache git
WORKDIR /app
COPY . .
CMD ["npm", "test"]
