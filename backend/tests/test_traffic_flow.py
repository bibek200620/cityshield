from shapely.geometry import LineString

from app.routing.traffic_flow import match_flow_segments


def test_flow_colors_require_nearby_geometry_and_matching_direction():
    road = LineString([(0, 0), (100, 0), (200, 0), (300, 0), (400, 0)])
    samples = [
        ("slow", LineString([(0, 2), (100, 2)])),
        ("heavy", LineString([(100, 2), (200, 2)])),
        ("heavy", LineString([(300, 2), (200, 2)])),
        ("heavy", LineString([(300, 40), (400, 40)])),
    ]
    assert match_flow_segments(road, samples) == [
        {"start_index": 0, "end_index": 1, "level": "slow"},
        {"start_index": 1, "end_index": 2, "level": "heavy"},
        {"start_index": 2, "end_index": 4, "level": "unknown"},
    ]
