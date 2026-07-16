# Mirrors the PRODUCT CONFIG table in
# claude-code/skills/social-intent-leads/SKILL.md — keep both in sync.
# To add a new product, add a row here with its own keyword sets and ICP.

PRODUCT_CONFIG = {
    "pagetest": {
        "name": "PageTest.AI",
        "positioning": (
            "AI-powered, code-free A/B and multivariate testing platform for "
            "website copy. Point-and-click element selection, AI generates "
            "variations, auto-identifies the winner. No dev work required."
        ),
        "broad_keywords": [
            "A/B testing",
            "A/B test",
            "split testing",
            "conversion rate optimization",
        ],
        "high_intent_keywords": [
            "best A/B testing tool",
            "A/B testing platform recommendation",
            "switching from Optimizely",
            "switching from VWO",
            "which CRO tool",
        ],
        "icp_titles": [
            "VP Marketing",
            "Head of Marketing",
            "Growth Marketing",
            "Marketing Director",
            "CMO",
            "Head of Growth",
        ],
        "icp_company_size_min": 50,
        "icp_company_size_max": 200,
        "icp_industries": ["SaaS", "Software", "Internet"],
    }
}


def get_product_config(key: str) -> dict:
    if key not in PRODUCT_CONFIG:
        raise KeyError(
            f"Unknown product '{key}'. Add it to PRODUCT_CONFIG in product_config.py "
            f"and to the PRODUCT CONFIG table in SKILL.md."
        )
    return PRODUCT_CONFIG[key]
