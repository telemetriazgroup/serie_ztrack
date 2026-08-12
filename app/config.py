from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://ztrack:ztrack@db:5432/ztrack"
    timezone: str = "America/Lima"
    api_port: int = 9490
    jwt_secret: str = "ztrack-serie-jwt-secret-change-me-2023"
    jwt_expire_hours: int = 12
    superuser_username: str = "ztrack"
    superuser_password: str = "proyectoztrack2023"


settings = Settings()
