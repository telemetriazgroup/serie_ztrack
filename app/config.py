from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://ztrack:ztrack@db:5432/ztrack"
    timezone: str = "America/Lima"
    api_port: int = 9490


settings = Settings()
