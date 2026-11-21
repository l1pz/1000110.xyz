from pathlib import Path

import pytest

from app.config import Config
from app.models import Result
from app.sources.annas import ChallengeRequired, Details, SourceUnavailable
from app.store import Store
from app.worker import Worker, _reason, safe_filename


class FakeAnnas:
    def __init__(self, error: Exception | None = None, fmt: str = "EPUB"):
        self.error = error
        self.fmt = fmt

    def details(self, md5: str) -> Details:
        if self.error:
            raise self.error
        return Details(title="KADDIS", author="Imre Kertész", format=self.fmt)

    def download(self, md5: str, dest: Path, wait: bool = True) -> str:
        if self.error:
            raise self.error
        dest.write_bytes(b"PK\x03\x04")
        return dest.name


class FakeLibgen:
    def __init__(self, results: list[Result] | None = None, error: Exception | None = None):
        self.results = results or []
        self.error = error
        self.downloaded: list[str] = []

    def search(self, query: str) -> list[Result]:
        if self.error:
            raise self.error
        return self.results

    def download(self, md5: str, dest: Path) -> str:
        self.downloaded.append(md5)
        dest.write_bytes(b"PK\x03\x04")
        return dest.name


@pytest.fixture
def worker(tmp_path):
    config = Config(data_dir=tmp_path)
    config.ensure_dirs()
    return Worker(config, Store(config.db_path))


def add_and_claim(worker: Worker, **fields) -> object:
    worker.store.add_book(**fields)
    return worker.store.claim_next()


def test_filename_is_safe_for_the_kindle():
    name = safe_filename('Egri csillagok: háború?/', "Hernádi Gyula", "epub")

    assert name == "Egri csillagok háború - Hernádi Gyula.epub"
    assert not any(char in name for char in '<>:"/\\|?*')


def test_empty_title_still_gets_a_name():
    assert safe_filename("", "", "epub") == "könyv.epub"


def test_successful_download_marks_the_book_ready(worker):
    worker.annas = FakeAnnas(fmt="EPUB")
    book = add_and_claim(worker, title="Kaddis", author="Imre Kertész", md5="a" * 32, format="EPUB")

    worker.process(book)

    stored = worker.store.get_book(book.id)
    assert stored.status == "ready"
    assert stored.filename == "Kaddis - Imre Kertész.epub"
    assert Path(stored.file_path).read_bytes() == b"PK\x03\x04"


def test_annas_failure_falls_back_to_libgen(worker):
    worker.annas = FakeAnnas(error=ChallengeRequired())
    worker.libgen = FakeLibgen(results=[Result(title="Kaddis", author="Imre Kertész", format="MOBI", md5="b" * 32)])
    book = add_and_claim(worker, title="Kaddis", author="Imre Kertész", md5="a" * 32, format="EPUB")

    worker.process(book)

    stored = worker.store.get_book(book.id)
    assert stored.status == "ready"
    assert stored.filename.endswith(".mobi")
    assert worker.libgen.downloaded == ["b" * 32]


def test_two_failures_give_a_hungarian_reason(worker):
    worker.annas = FakeAnnas(error=SourceUnavailable("nincs példány"))
    worker.libgen = FakeLibgen(results=[])
    book = add_and_claim(worker, title="Ismeretlen", md5="a" * 32, format="EPUB")

    worker.process(book)

    stored = worker.store.get_book(book.id)
    assert stored.status == "failed"
    assert "Libgen" in stored.error


def test_a_challenge_alone_is_reported_as_such():
    assert "DDoS" in _reason(ChallengeRequired())
    assert "Váratlan" in _reason(ValueError("boom"))


def test_cleanup_deletes_sent_files(worker, tmp_path):
    book = add_and_claim(worker, title="Kész", format="EPUB")
    path = tmp_path / "kész.epub"
    path.write_bytes(b"x")
    worker.store.update_book(book.id, status="sent", file_path=str(path))

    assert worker.cleanup() == 1
    assert not path.exists()
    assert worker.store.get_book(book.id).file_path == ""


def test_cleanup_keeps_a_fresh_failed_file(worker, tmp_path):
    book = add_and_claim(worker, title="Hibás", format="EPUB")
    path = tmp_path / "hibás.epub"
    path.write_bytes(b"x")
    worker.store.update_book(book.id, status="failed", file_path=str(path))

    assert worker.cleanup() == 0
    assert path.exists()