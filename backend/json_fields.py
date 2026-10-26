"""Shared JSON selectors: unique field name, dotted path, or JSON Pointer."""
import copy


class FieldError(ValueError):
    pass


def pointer(parts):
    return '/' + '/'.join(str(p).replace('~', '~0').replace('/', '~1') for p in parts)


def locate(document, selector, *, create=False):
    if not isinstance(selector, str) or not selector:
        raise FieldError('Укажите имя поля или путь JSON')
    if selector.startswith('/'):
        parts = [p.replace('~1', '/').replace('~0', '~') for p in selector[1:].split('/')]
    elif '.' in selector:
        parts = selector.split('.')
    else:
        found, stack = [], [(document, [])]
        while stack:
            node, path = stack.pop()
            if isinstance(node, dict):
                for key, value in node.items():
                    child = [*path, key]
                    if key == selector:
                        found.append(child)
                        if len(found) == 6:
                            break
                    if isinstance(value, (dict, list)):
                        stack.append((value, child))
            elif isinstance(node, list):
                stack.extend((value, [*path, index]) for index, value in enumerate(node)
                             if isinstance(value, (dict, list)))
            if len(found) == 6:
                break
        if len(found) > 1:
            paths = ', '.join(pointer(p) for p in found[:5])
            raise FieldError(f'Поле «{selector}» неоднозначно. Укажите точный путь: {paths}' + (' …' if len(found) > 5 else ''))
        if not found:
            raise FieldError(f'Поле «{selector}» не найдено. Для добавления используйте точный путь /{selector}')
        parts = found[0]
    target = document
    try:
        for part in parts[:-1]:
            target = target[int(part)] if isinstance(target, list) else target[part]
        key = int(parts[-1]) if isinstance(target, list) else parts[-1]
        if not isinstance(target, (dict, list)) or isinstance(target, list) and key < 0:
            raise KeyError(selector)
        if not create or isinstance(target, list):
            target[key]
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise FieldError(f'Путь JSON не найден: {selector}') from exc
    return target, key


def get_field(document, selector):
    target, key = locate(document, selector)
    return target[key]


def set_field(document, selector, value):
    target, key = locate(document, selector, create=True)
    target[key] = value
    return document


def remove_field(document, selector):
    target, key = locate(document, selector)
    del target[key]
    return document


class Json:
    """An explicit selector API; .data remains an ordinary Python JSON value."""
    def __init__(self, data):
        self.data = copy.deepcopy(data)

    def get(self, selector):
        return get_field(self.data, selector)

    def set(self, selector, value):
        set_field(self.data, selector, value)
        return self

    def remove(self, selector):
        remove_field(self.data, selector)
        return self
