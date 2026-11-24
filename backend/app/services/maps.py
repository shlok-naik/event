"""Google Maps, proxied server-side so the API key never reaches the browser.

Uses the Geocoding API (address <-> coordinates) and Places API (New) Text Search
(free-text place search). Enable both for the key in Google Cloud and restrict the key
to them.
"""
import httpx

from app.config import Settings
from app.errors import BadRequest, ServiceUnavailable

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PLACES_FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.location"


class MapsClient:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None):
        self.settings = settings
        self._transport = transport

    def _key(self) -> str:
        if not self.settings.google_maps_api_key:
            raise ServiceUnavailable("Location search is not configured", code="maps_not_configured")
        return self.settings.google_maps_api_key.get_secret_value()

    def _client(self) -> httpx.Client:
        return httpx.Client(timeout=self.settings.google_maps_timeout_seconds, transport=self._transport)

    def search(self, query: str, near: tuple[float, float] | None = None, limit: int = 8) -> list[dict]:
        body: dict = {"textQuery": query, "pageSize": limit}
        if near:
            body["locationBias"] = {"circle": {"center": {"latitude": near[0], "longitude": near[1]}, "radius": 20000.0}}
        headers = {"X-Goog-Api-Key": self._key(), "X-Goog-FieldMask": PLACES_FIELD_MASK}
        data = self._request("POST", PLACES_SEARCH_URL, json=body, headers=headers)
        return [
            {
                "place_id": p.get("id"),
                "name": (p.get("displayName") or {}).get("text"),
                "address": p.get("formattedAddress"),
                "latitude": (p.get("location") or {}).get("latitude"),
                "longitude": (p.get("location") or {}).get("longitude"),
            }
            for p in data.get("places", [])
        ]

    def geocode(self, address: str) -> list[dict]:
        return self._geocode({"address": address})

    def reverse_geocode(self, lat: float, lng: float) -> list[dict]:
        return self._geocode({"latlng": f"{lat},{lng}"})

    def _geocode(self, params: dict) -> list[dict]:
        data = self._request("GET", GEOCODE_URL, params={**params, "key": self._key()})
        status = data.get("status")
        if status == "ZERO_RESULTS":
            return []
        if status != "OK":
            raise ServiceUnavailable("Location lookup failed", code="maps_error")
        return [
            {
                "place_id": r.get("place_id"),
                "name": None,
                "address": r.get("formatted_address"),
                "latitude": r["geometry"]["location"]["lat"],
                "longitude": r["geometry"]["location"]["lng"],
            }
            for r in data.get("results", [])[:8]
        ]

    def _request(self, method: str, url: str, **kwargs) -> dict:
        try:
            with self._client() as client:
                r = client.request(method, url, **kwargs)
        except httpx.HTTPError:
            raise ServiceUnavailable("Location service unreachable", code="maps_unreachable")
        if r.status_code == 400:
            raise BadRequest("Invalid location query")
        if r.status_code >= 400:
            # Never echo Google's error body: it can include request details.
            raise ServiceUnavailable("Location lookup failed", code="maps_error")
        return r.json()
