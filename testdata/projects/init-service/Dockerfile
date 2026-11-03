FROM node:24-alpine
# js-prueffactory does not run this Dockerfile, it only reads the base image
# from it. The compose service migrate builds it.
WORKDIR /app
COPY . .
CMD ["npm", "start"]
