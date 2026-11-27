FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin libgdal-dev libgomp1 gcc g++ \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Train the synthetic model during the image build so the free web service
# can load its checkpoint instead of training before it binds the HTTP port.
ARG GRID_SIZE_CELLS=25
ARG GRID_RESOLUTION_M=80
RUN PILOT_MODE=synthetic GRID_SIZE_CELLS=${GRID_SIZE_CELLS} \
    GRID_RESOLUTION_M=${GRID_RESOLUTION_M} \
    python -c "from app.ml.train import train; train(out_dir='app/ml/checkpoints/synthetic')"

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
