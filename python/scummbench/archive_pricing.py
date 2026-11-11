"""Recompute archived costs using archived rates; no network lookup."""

def calculate(usage_helper, snapshot, rates):
    report = usage_helper.price(snapshot, rates, assume_tier="standard")
    # Source-read warnings live in run.json; an unfinished trailing source record
    # is deliberately absent from the normalized archived trajectory.
    report.pop("warnings", None)
    report["assumptions"].append("Global processing; no regional premium")
    return {"status": "priced", "provider": snapshot["provider"],
            "basis": "api_equivalent_model_tokens", "total_api_price_usd": report["total_model_token_cost"],
            "rates": rates, **report}
