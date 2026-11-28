# Bengaluru storm observations request

**Status** — Ready to send. No request has been sent, and no paired observation files were obtained. The request covers one catchment. Its goal is to compare CityShield-predicted water levels with measured levels at the same drain and time.

## Where to request access

Send the request to the Director, Karnataka State Natural Disaster Monitoring Centre (KSNDMC), at `director@ksndmc.org`. The Bengaluru flood study directs requests for its high-resolution observations to this office, and the agency lists the same role inbox. Ask KSNDMC to identify the drainage asset custodian if historical geometry requires a separate release. [Study data availability](https://www.frontiersin.org/journals/earth-science/articles/10.3389/feart.2022.883842/full#h9) · [KSNDMC contact information](https://ksndmc.org/GraphicalRainAnalysis.aspx/RTI)

The state flood action plan documents collection of 15-minute rainfall and drain water levels. Its public weather and warning products do not establish access to the matched historical records. The KWRIS raw stream-gauge page redirected to sign-in, and coverage of the study's drain sensors was unverified. The published supplement provides selected observations and model results. It lacks the raw paired series and verified sensor coordinates. [Karnataka flood action plan, p. 130](https://revenue.karnataka.gov.in/uploads/media_to_upload1712739726.pdf) · [KWRIS raw stream-gauge page](https://kwris.aciwrm.org/RawDataDownloadSG) · [Study supplement, Tables S3 and S6](https://ndownloader.figshare.com/files/35248909)

## Email draft

**To** — Director, Karnataka State Natural Disaster Monitoring Centre

**Subject** — Request for Bengaluru storm rainfall, drain water levels, and station metadata

Dear Director,

I’m working on CityShield, a Bengaluru flood-modeling research project. I’m requesting existing observations to check how well the model reproduces measured stormwater levels in one catchment.

Could KSNDMC share the native 15-minute rainfall and drain water-level series for the 20–21 October 2020 storm in the Koramangala–Chellaghatta catchment, starting with Hulimavu Lake Inlet sensor WLS 100003 and the relevant rain gauges? If records are stronger in another catchment, a comparable matched export would be useful. We would also like records for at least one other independent storm in the same catchment, ideally two. Please include about 24 hours before and after each event where available.

CSV or another machine-readable format is suitable. Please include event windows, station IDs and surveyed coordinates, timestamp conventions and units, missing values and quality flags, sensor measurement references, and the drain segment at each water-level sensor. For the local drainage model, we would appreciate available network geometry, connectivity, and surveyed drain inverts and cross-sections for those events, or a referral to the authority that holds them.

The published study reports the same depth at two different times for WLS 100003. If available, please identify the authoritative event record. If WLS 100021 is included, could you clarify the 2.332 m and 0.9 m readings attributed to 00:45 IST on 21 October in the supplement?

Please indicate the access process, any fees, and the applicable terms for internal research and for sharing derived plots and evaluation results. Let me know if you need a project summary or institutional request form.

Thank you,

[Name, affiliation, and reply contact]

## What the import needs

| Record | Required information |
| --- | --- |
| Event | Stable event ID, date range and time zone, and the period actually covered. |
| Rain gauge | Verified station ID and coordinates, timestamped 15-minute rainfall, units, interval start or end convention, incremental or cumulative definition, and quality flags. |
| Drain sensor | Verified sensor ID and coordinates valid during the event, timestamped levels, units, vertical datum and sensor offset or depth reference, and quality flags. |
| Network mapping | Documented sensor-to-drain segment crosswalk and the network version in force during the event. Hydraulic model inputs also require drain connectivity and surveyed inverts and cross-sections. |
| Provenance | Custodian, export date and version, field definitions, source permission, and allowed uses. |

For the first replay, confirm compatible rain and water-level intervals and enough quality-accepted observations to capture the event peak. Preserve gaps and equipment outages as missing measurements. Document the reason for any excluded or conflicting value. Reserve an entire independent storm for evaluation before reporting model performance. The official audit documents outages in the later Bengaluru network, which makes historical station identity and operating dates important during intake. [CAG Karnataka audit, §5.3.3.4](https://saiindia.gov.in/uploads/download_audit_report/2025/REPORT-8-OF-2025---ENGLISH-0694389fd547e10.69426873.pdf) · [CityShield evidence notes](FLOOD_EVENT_DATA.md)
