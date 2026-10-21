"""«По ссылке»: сайты, которые владелец закрыл после жалобы (A9, `CINEMA_LINK_HOSTS_DENY`)."""

import unittest
import uuid

import httpx

from cord_services.cinema.facade import DENIED_HOST, Cinema, denied, deny_list

ROOM = str(uuid.UUID(int=7))


class DenyList(unittest.TestCase):
    def test_hosts_are_read_like_an_owner_writes_them(self):
        self.assertEqual(deny_list(" Films.Example., www.bad.test  other.test "),
                         frozenset({"films.example", "bad.test", "other.test"}))
        self.assertEqual(deny_list(None), frozenset())
        self.assertEqual(deny_list(""), frozenset())

    def test_a_closed_site_closes_its_subdomains_but_not_lookalikes(self):
        hosts = deny_list("films.example")
        self.assertTrue(denied("https://films.example/watch/1", hosts))
        self.assertTrue(denied("https://cdn.films.example/a.mp4", hosts))
        self.assertTrue(denied("https://FILMS.example./x", hosts))
        self.assertFalse(denied("https://notfilms.example/x", hosts))
        self.assertFalse(denied("https://films.example.org/x", hosts))


class Refusal(unittest.IsolatedAsyncioTestCase):
    async def test_a_closed_site_is_refused_before_anything_leaves_the_server(self):
        asked = []

        def nowhere(request):
            asked.append(str(request.url))
            return httpx.Response(500)

        cinema = Cinema(
            "secret-of-thirty-two-characters!",
            httpx.AsyncClient(transport=httpx.MockTransport(nowhere)),
            deny_hosts="films.example",
        )
        try:
            answer = await cinema.link("https://www.films.example/watch/1", room=ROOM)
            self.assertEqual(answer, {"item": None, "reason": DENIED_HOST})
            self.assertEqual(asked, [])
        finally:
            await cinema.close()


if __name__ == "__main__":
    unittest.main()
