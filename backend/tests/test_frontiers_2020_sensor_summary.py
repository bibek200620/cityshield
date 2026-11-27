import csv
from datetime import datetime
from pathlib import Path


DATA_PATH = Path(__file__).parents[2] / "docs/data/flood_events/frontiers_2020_sensor_summary.csv"


def test_frontiers_sensor_summary_is_attributed_and_explicitly_not_evaluation_eligible():
    with DATA_PATH.open(encoding="utf-8", newline="") as source:
        records = list(csv.DictReader(source))

    assert len(records) == 5
    assert len({row["wls_id"] for row in records}) == 5
    assert {row["event_id"] for row in records} == {"BLR-2020-10-20"}
    assert {row["supplement_doi"] for row in records} == {"10.3389/feart.2022.883842.s001"}
    assert {row["source_license"] for row in records} == {"CC BY 4.0"}
    assert all(row["evaluation_eligible"] == "false" for row in records)
    assert all(row["latitude"] == row["longitude"] == "" for row in records)
    assert all(row["event_rainfall_max_24h_mm"] == "124.5" for row in records)

    for row in records:
        stamp = datetime.fromisoformat(row["observation_timestamp_local"])
        assert stamp.utcoffset().total_seconds() == 5.5 * 3600
        flow = float(row["observed_flow_depth_m"])
        drain = float(row["drain_depth_m"])
        expected_ratio = flow / drain * 100
        expected_excess = (flow / drain - 1) * 100
        assert abs(float(row["flow_as_pct_drain_depth"]) - expected_ratio) < 0.001
        assert abs(float(row["excess_over_drain_depth_pct"]) - expected_excess) < 0.001


def test_two_user_supplied_summary_rows_match_paper_sensor_rows_by_values_not_order():
    with DATA_PATH.open(encoding="utf-8", newline="") as source:
        records = list(csv.DictReader(source))

    matches = {row["user_csv_observation_id"]: row for row in records if row["user_csv_observation_id"]}
    assert set(matches) == {
        "BLR-2020-10-20-VV-01",
        "BLR-2020-10-20-VV-02",
    }
    assert matches["BLR-2020-10-20-VV-01"]["wls_id"] == "100021"
    assert matches["BLR-2020-10-20-VV-01"]["excess_over_drain_depth_pct"] == "122.0952"
    assert matches["BLR-2020-10-20-VV-01"]["table_s6_observed_max_m"] == "0.9"
    assert matches["BLR-2020-10-20-VV-02"]["wls_id"] == "100034"
    assert matches["BLR-2020-10-20-VV-02"]["excess_over_drain_depth_pct"] == "21.4286"
