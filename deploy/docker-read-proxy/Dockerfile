FROM python:3.12-alpine
WORKDIR /app
COPY proxy.py .
USER 65534:65534
CMD ["python3", "-u", "proxy.py"]
