FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY game.py server.py ./
COPY static ./static
RUN useradd --create-home bingo
USER bingo
EXPOSE 8000
CMD ["python", "server.py"]
