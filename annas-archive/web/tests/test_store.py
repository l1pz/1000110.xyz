import time

import pytest

from app.store import Store


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "books.db")


def test_books_round_trip(store):
    book = store.add_book(title="Egri csillagok", author="Gárdonyi Géza", format="EPUB", md5="a" * 32)

    assert book.status == "queued"
    assert book.id
    assert store.get_book(book.id).title == "Egri csillagok"
    assert store.get_book("nope") is None


def test_claim_moves_exactly_one_book(store):
    first = store.add_book(title="Első")
    second = store.add_book(title="Második")

    claimed = store.claim_next()

    assert claimed.id == first.id
    assert store.get_book(first.id).status == "downloading"
    assert store.get_book(second.id).status == "queued"
    assert store.list_books(statuses=("queued",))[0].id == second.id


def test_claim_on_an_empty_queue(store):
    assert store.claim_next() is None


def test_update_book_ignores_unknown_fields(store):
    book = store.add_book(title="Teszt")

    store.update_book(book.id, status="ready", filename="x.epub", nonsense="nope")

    updated = store.get_book(book.id)
    assert updated.status == "ready"
    assert updated.filename == "x.epub"
    assert not hasattr(updated, "nonsense")


def test_reset_stuck_requeues_downloads(store):
    book = store.add_book(title="Félbeszakadt")
    store.claim_next()

    assert store.reset_stuck() == 1
    assert store.get_book(book.id).status == "queued"


def test_cookies_round_trip(store):
    store.set_cookies({"aa_ddg_check": "token", "__ddg5_": "abc"})
    store.set_cookies({"aa_ddg_check": "new"})

    assert store.cookies() == {"aa_ddg_check": "new", "__ddg5_": "abc"}

    store.clear_cookies()
    assert store.cookies() == {}


def test_find_book_by_md5(store):
    store.add_book(title="Egy", md5="b" * 32)

    assert store.find_book("b" * 32).title == "Egy"
    assert store.find_book("") is None
    assert store.find_book("c" * 32) is None


def test_devices_need_a_name_to_register(store):
    assert store.touch_device("") is False
    assert store.touch_device("unknown") is False
    assert store.touch_device("kindle", name="Paperwhite") is True
    assert store.touch_device("kindle") is True


def test_ready_books_returns_only_ready(store):
    ready = store.add_book(title="Kész")
    store.update_book(ready.id, status="ready")
    store.add_book(title="Vár")

    assert [book.id for book in store.ready_books()] == [ready.id]