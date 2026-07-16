from typing import Optional, Literal
from pydantic import BaseModel


class SearchProfile(BaseModel):
    name: str
    slug: Optional[str] = None
    product: str = "pagetest"
    count: int = 10
    titles: str = "VP Marketing"
    companySizeMin: int = 50
    companySizeMax: int = 200
    companyType: str = "SaaS"
    location: Optional[str] = None  # optional — blank means anywhere
    intentKeywords: str = ""
    recency: Literal["PAST_24H", "PAST_WEEK", "PAST_MONTH"] = "PAST_WEEK"
    fetchEmails: bool = True


class ProcessBatchRequest(BaseModel):
    profile: SearchProfile
    batchSize: int = 10


class QueueItem(BaseModel):
    name: str
    profileUrl: Optional[str] = None
    postUrl: str
    score: int
    isInfluencer: bool = False
    connectReason: Optional[Literal["direct-buyer", "influencer"]] = None
    action: Literal["skip", "comment", "comment+connect"]
    skipReason: Optional[str] = None
    comment: Optional[str] = None
    connectionNote: Optional[str] = None
    dmMessage: Optional[str] = None
    email: Optional[str] = None
    emailStatus: Optional[Literal["valid", "risky", "invalid", "unknown"]] = None
    sourceLabel: str


class RunStatus(BaseModel):
    runId: str
    status: Literal["pending", "running", "completed", "failed"]
    product: str
    createdAt: str
    error: Optional[str] = None
    itemCount: Optional[int] = None
    scoreDistribution: Optional[dict] = None
