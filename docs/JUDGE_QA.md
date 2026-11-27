# Research MVP Q&A

**Q: Is this an operational flood-warning system?**  
A: No. It is a research simulation with user-entered rainfall scenarios. The default local network is synthetic; GNN training labels come from the project's simplified physics baseline. There are no observed flood-event validation records.

**Q: Are these depths measured in Bellandur streets?**  
A: No. In the default mode, coordinates only place synthetic geometry inside the Bellandur map extent. Real mode can ingest OSM roads/facilities and terrain, but its GNN still predicts from simulation-derived training labels, waterways are an inferred drainage proxy, and land use/pipe dimensions are assumed. It does not provide validated street water depths.

**Q: What does the heat layer show?**  
A: If a licensed Landsat 8/9 Collection 2 Level-2 scene and matching model are supplied, it shows a single-scene modelled land-surface temperature pattern. It is not air temperature or a heatwave forecast. No scene/model is bundled in the default checkout.

**Q: How does combined exposure work?**  
A: Independent flood and heat outputs are aligned to 30 m EPSG:32643 cells. A cell is marked “both elevated” only if flood node depth is at least 0.15 m and Landsat LST is in the scene's relative top decile. It is a display overlay, not a calibrated probability.

**Q: Is there weather or historical event data?**  
A: No verified weather or time-stamped flood incident source is configured. The weather endpoint reports unavailable, and event-level flood validation is unavailable.

**Q: Can I use route outputs for emergency navigation?**  
A: No. They compare routes over simulated road classes with assumed vehicle speeds; they are not directions, traffic estimates, or safe-road guidance.
