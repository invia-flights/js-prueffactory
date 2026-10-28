FROM node:24-alpine
# js-prueffactory does not run this Dockerfile, it only reads the base image
# from it. On Alpine (musl) a lookup of an unknown host takes 5 s by default;
# on Debian (glibc) it fails at once.
WORKDIR /app
COPY . .
CMD ["npm", "test"]
