FROM python:3.12-alpine
WORKDIR /app
COPY unsealer.py .
RUN chmod +x unsealer.py
CMD ["python3", "-u", "unsealer.py"]
